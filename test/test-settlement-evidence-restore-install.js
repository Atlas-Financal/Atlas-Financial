'use strict';
// Maintenance install/readback foundation (ATLAS-080): synthetic fixtures only.
// REAL dependencies: the contract (C.pin), the real store + terminal-certificate
// protocol (via the shared exclusion world) to produce committed ledger and
// sealed history bytes, the real #707 validator, and the real PostgreSQL
// adapter ONLY to read its advisory-key derivation over a recording double.
// DOUBLES (labelled): an in-memory SQL session double that interprets the
// module's fixed statements with BEGIN/COMMIT/ROLLBACK snapshot semantics.
// It qualifies PROTOCOL ONLY: not PostgreSQL behaviour, isolation, grants,
// provisioning or real lock semantics. Non-claims: anchors are trusted input;
// quiescence and restart inhibition are external; 'installed-unverified' and
// 'verified' are not restore/reopen success.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const C = require('../scripts/planned-obligation-settlement-contract');
const TC = require('../scripts/settlement-evidence-terminal-certificate');
const X = require('./test-settlement-evidence-terminal-certificate');
const MODULE = path.join(__dirname, '..', 'scripts', 'settlement-evidence-restore-install.js');
const M = require(MODULE);
const { householdId } = X;
const SCHEMA = 'atlas_settle', SCOPE = 'household-a';

async function world() {
  const w = X.makeExclusionWorld(), s = w.newStore(), snaps = { ledger: [Buffer.from(w.doc)], history: [Buffer.from(w.historyBytes)] };
  for (const n of [1, 2]) {
    const p = await w.prepare(s, n);
    assert.equal((await s.commit(w.input(p))).status, 'committed');
    snaps.ledger.push(Buffer.from(w.doc));
  }
  const p3 = await w.prepare(s, 3);
  assert.equal((await w.seal(s, p3, 3)).status, 'certified');
  snaps.history.push(Buffer.from(w.historyBytes));
  const ns = w.domain.ledgerNamespace;
  const la = b => { const v = JSON.parse(b); return { revision: v.revision, documentDigest: v.digest }; };
  const ha = b => { const v = JSON.parse(b); return { schema: 'terminal-history-checkpoint-1', householdId: v.householdId, ledgerNamespace: v.ledgerNamespace, revision: v.revision, digest: v.digest }; };
  const ledgerBytes = snaps.ledger[2], historyBytes = snaps.history[1];
  const checkpointBytes = Buffer.from(JSON.stringify(ha(historyBytes)));
  const base = (session, o = {}) => ({
    session, schema: SCHEMA, scope: SCOPE,
    domain: { householdId, ledgerNamespace: ns },
    anchors: { ledger: la(ledgerBytes), history: ha(historyBytes) },
    candidate: { ledgerBytes: Buffer.from(ledgerBytes), historyBytes: Buffer.from(historyBytes) }, ...o,
  });
  return { ns, snaps, ledgerBytes, historyBytes, checkpointBytes, base, pin: C.pin(ledgerBytes, householdId), la, ha };
}

// ---- SQL session DOUBLE (protocol only) ----
function makeDb(seed = {}) {
  const db = { head: new Map(), staged: new Map(), journal: new Map(), terminal: new Map(), quarantine: new Map(), lockOwner: null, lockKeys: [], nextPid: 100 };
  for (const k of ['head', 'staged', 'journal']) if (seed[k]) db[k].set(SCOPE, Buffer.from(seed[k]));
  if (seed.terminal) db.terminal.set(SCOPE, { h: Buffer.from(seed.terminal.h), c: Buffer.from(seed.terminal.c) });
  return db;
}
const clone = db => ({ head: new Map(db.head), staged: new Map(db.staged), journal: new Map(db.journal),
  terminal: new Map(db.terminal), quarantine: new Map(db.quarantine) });
const TBL = { doc_head: 'head', doc_staged: 'staged', journal: 'journal' };
function makeSession(db, hooks = {}) {
  const pid = db.nextPid++;
  const listeners = { error: [], end: [] };
  let snap = null, retired = 0, n = 0, ended = false;
  const log = [];
  const abort = () => { if (snap) { Object.assign(db, snap); snap = null; } if (db.lockOwner === pid) db.lockOwner = null; };
  const session = {
    log, pid, listeners,
    get retired() { return retired; },
    on(ev, fn) { listeners[ev].push(fn); },
    retire() { retired++; ended = true; abort(); return Promise.resolve(); },
    emit(ev) { for (const fn of listeners[ev]) fn(); },
    async query(text, values) {
      const i = n++;
      log.push(text);
      if (ended) throw new Error('ended');
      if (hooks.before) { const r = await hooks.before(text, values, i, session); if (r !== undefined) return r; }
      const r = exec(text, values);
      if (hooks.after) { const o = hooks.after(text, values, i, r, session); if (o !== undefined) return o; }
      return r;
    },
  };
  const res = (command, rows = [], rowCount = rows.length) => ({ command, rows, rowCount });
  function exec(text, v) {
    let m;
    if (/pg_try_advisory_lock/.test(text)) {
      db.lockKeys.push(v);
      if (db.lockOwner !== null && db.lockOwner !== pid) return res('SELECT', [{ locked: false }]);
      db.lockOwner = pid; return res('SELECT', [{ locked: true }]);
    }
    if (/pg_backend_pid/.test(text)) return res('SELECT', [{ pid }]);
    if (/^BEGIN/.test(text)) { snap = clone(db); return res('BEGIN', [], null); }
    if (text === 'COMMIT') { snap = null; return res('COMMIT', [], null); }
    if (text === 'ROLLBACK') { abort(); db.lockOwner = pid; return res('ROLLBACK', [], null); }
    if ((m = /^SELECT bytes FROM "atlas_settle"\.(doc_head|doc_staged|journal) WHERE scope = \$1 LIMIT 2$/.exec(text))) {
      const b = db[TBL[m[1]]].get(v[0]); return res('SELECT', b ? [{ bytes: Buffer.from(b) }] : []);
    }
    if (/^SELECT history_bytes, checkpoint_bytes FROM "atlas_settle"\.terminal_history WHERE scope = \$1 LIMIT 2$/.test(text)) {
      const t = db.terminal.get(v[0]); return res('SELECT', t ? [{ history_bytes: Buffer.from(t.h), checkpoint_bytes: Buffer.from(t.c) }] : []);
    }
    if (/^SELECT 1 AS present FROM "atlas_settle"\.quarantine WHERE scope = \$1 AND name = \$2$/.test(text))
      return res('SELECT', db.quarantine.has(v[0] + '|' + v[1]) ? [{ present: 1 }] : []);
    if (/^INSERT INTO "atlas_settle"\.quarantine \(scope, name, label, bytes\) VALUES/.test(text)) {
      const k = v[0] + '|' + v[1]; if (db.quarantine.has(k)) throw new Error('duplicate key');
      db.quarantine.set(k, { label: v[2], bytes: Buffer.from(v[3]) }); return res('INSERT', [], 1);
    }
    if (/^INSERT INTO "atlas_settle"\.doc_head \(scope, bytes\) VALUES \(\$1, \$2\) ON CONFLICT \(scope\) DO UPDATE SET bytes = EXCLUDED\.bytes$/.test(text)) {
      db.head.set(v[0], Buffer.from(v[1])); return res('INSERT', [], 1);
    }
    if (/^UPDATE "atlas_settle"\.terminal_history SET history_bytes = \$2, checkpoint_bytes = \$3 WHERE scope = \$1$/.test(text)) {
      if (!db.terminal.has(v[0])) return res('UPDATE', [], 0);
      db.terminal.set(v[0], { h: Buffer.from(v[1]), c: Buffer.from(v[2]) }); return res('UPDATE', [], 1);
    }
    if (/^INSERT INTO "atlas_settle"\.terminal_history \(scope, history_bytes, checkpoint_bytes\) VALUES \(\$1, \$2, \$3\)$/.test(text)) {
      if (db.terminal.has(v[0])) throw new Error('duplicate key');
      db.terminal.set(v[0], { h: Buffer.from(v[1]), c: Buffer.from(v[2]) }); return res('INSERT', [], 1);
    }
    if ((m = /^DELETE FROM "atlas_settle"\.(doc_staged|journal) WHERE scope = \$1$/.exec(text))) {
      const t = db[TBL[m[1]]]; const had = t.delete(v[0]); return res('DELETE', [], had ? 1 : 0);
    }
    throw new Error('double: unexpected statement ' + text);
  }
  return session;
}
const frozenDeep = o => { if (o && typeof o === 'object') { assert.ok(Object.isFrozen(o)); Object.values(o).forEach(frozenDeep); } };
const writes = log => log.filter(t => /^(INSERT|UPDATE|DELETE)/.test(t));

// ---------------- install ----------------
test('install over an empty scope: exact pair + deterministic checkpoint, installed-unverified only, session retired', async () => {
  const f = await world(); const db = makeDb(); const s = makeSession(db);
  const r = await M.installRestoreCandidate(f.base(s));
  assert.equal(r.status, 'installed-unverified'); frozenDeep(r);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { status: 'installed-unverified', householdId, ledgerNamespace: f.ns,
    ledger: { revision: 2, documentDigest: JSON.parse(f.ledgerBytes).digest, pin: f.pin },
    history: { revision: 1, digest: JSON.parse(f.historyBytes).digest }, quarantined: [], clearedStaged: false, clearedJournal: false });
  assert.ok(db.head.get(SCOPE).equals(f.ledgerBytes));
  assert.ok(db.terminal.get(SCOPE).h.equals(f.historyBytes));
  assert.ok(db.terminal.get(SCOPE).c.equals(f.checkpointBytes));
  // checkpoint independently equals the history's own identity fields (second method)
  const h = JSON.parse(f.historyBytes);
  assert.deepEqual(JSON.parse(db.terminal.get(SCOPE).c), { schema: 'terminal-history-checkpoint-1', householdId: h.householdId, ledgerNamespace: h.ledgerNamespace, revision: h.revision, digest: h.digest });
  assert.equal(s.retired, 1); assert.equal(db.lockOwner, null);
  assert.equal(Object.keys(r).some(k => /reopen|restored|authority|success/i.test(k)), false);
  assert.equal(s.log.filter(t => t === 'COMMIT').length, 1);
});

test('one transaction quarantines ALL incumbent head/staged/journal/history/checkpoint bytes (corrupt-but-bounded included) before replacement', async () => {
  const f = await world();
  const corrupt = Buffer.from('{not json'), j = Buffer.alloc(3 * 1024 * 1024, 7); // over document cap, within quarantine cap
  const db = makeDb({ head: corrupt, staged: Buffer.from('staged'), journal: j, terminal: { h: Buffer.from('old-history'), c: Buffer.from('old-cp') } });
  const s = makeSession(db);
  const r = await M.installRestoreCandidate(f.base(s));
  assert.equal(r.status, 'installed-unverified');
  assert.deepEqual(r.quarantined.map(q => q.kind), ['head', 'staged', 'journal', 'history', 'checkpoint']);
  const q = [...db.quarantine.values()];
  assert.deepEqual(q.map(x => x.label), Object.values(M.QUARANTINE_LABELS));
  assert.ok(q[0].bytes.equals(corrupt) && q[2].bytes.equals(j) && q[3].bytes.equals(Buffer.from('old-history')) && q[4].bytes.equals(Buffer.from('old-cp')));
  assert.equal(q[2].bytes.length, j.length, 'raw bytes, not base64-expanded');
  assert.equal(db.staged.size + db.journal.size, 0);
  assert.equal(r.clearedStaged && r.clearedJournal, true);
  // ordering: every quarantine insert precedes every replacement/removal, all inside one BEGIN..COMMIT
  const L = s.log, begin = L.findIndex(t => /^BEGIN/.test(t)), commit = L.indexOf('COMMIT');
  const lastQ = L.map((t, i) => /quarantine \(/.test(t) ? i : -1).filter(i => i >= 0).pop();
  const firstReplace = L.findIndex(t => /^(INSERT INTO "atlas_settle"\.(doc_head|terminal_history)|UPDATE|DELETE)/.test(t));
  assert.ok(begin < lastQ && lastQ < firstReplace && firstReplace < commit);
  assert.equal(L.filter(t => /^BEGIN/.test(t)).length, 1);
  assert.ok(db.terminal.get(SCOPE).h.equals(f.historyBytes));
});

test('advisory key is byte-identical to the real PostgreSQL adapter derivation for the same schema+scope', async () => {
  const A = require('../scripts/settlement-evidence-postgres-adapter');
  const seen = [];
  const client = { on() {}, retire() {}, async query(text, v) { if (/try_advisory/.test(text)) { seen.push(v); return { rows: [{ locked: false }] }; } return { rows: [] }; } };
  const a = A.createSettlementEvidencePostgresAdapter({ client, schema: SCHEMA, scope: SCOPE });
  await assert.rejects(a.lock.withLock(async () => {}));
  const f = await world(); const db = makeDb(); await M.installRestoreCandidate(f.base(makeSession(db)));
  assert.deepEqual(db.lockKeys[0], seen[0]);
  // discriminating: a different scope derives a different key
  const db2 = makeDb(); await M.installRestoreCandidate({ ...f.base(makeSession(db2)), scope: 'household-b' });
  assert.notDeepEqual(db2.lockKeys[0], seen[0]);
});

test('lock held elsewhere: refused before BEGIN, zero writes, incumbent untouched', async () => {
  const f = await world(); const db = makeDb({ head: Buffer.from('incumbent') }); db.lockOwner = 9999;
  const s = makeSession(db);
  assert.deepEqual({ ...(await M.installRestoreCandidate(f.base(s))) }, { status: 'refused', reason: 'lock-held' });
  assert.equal(s.log.some(t => /^BEGIN/.test(t)), false); assert.equal(writes(s.log).length, 0);
  assert.ok(db.head.get(SCOPE).equals(Buffer.from('incumbent'))); assert.equal(s.retired, 1);
});

test('input ownership: mutation after call cannot change installed bytes; accessors refused without invocation', async () => {
  const f = await world(); const db = makeDb(); const s = makeSession(db);
  const input = f.base(s); const p = M.installRestoreCandidate(input);
  input.candidate.ledgerBytes.fill(0); input.candidate.historyBytes.fill(0);
  assert.equal((await p).status, 'installed-unverified');
  assert.ok(db.head.get(SCOPE).equals(f.ledgerBytes));
  let ran = false; const bad = f.base(makeSession(makeDb()));
  Object.defineProperty(bad, 'scope', { enumerable: true, get() { ran = true; return SCOPE; } });
  assert.deepEqual({ ...(await M.installRestoreCandidate(bad)) }, { status: 'refused', reason: 'input-malformed' });
  assert.equal(ran, false);
});

test('bounds and domain: oversize ledger/history, invalid candidate, wrong anchors, bad schema/scope all refuse with zero SQL', async () => {
  const f = await world();
  const cases = [
    [{ candidate: { ledgerBytes: Buffer.alloc(M.LEDGER_MAX_BYTES + 1, 32), historyBytes: f.historyBytes } }, 'candidate-oversize'],
    [{ candidate: { ledgerBytes: f.ledgerBytes, historyBytes: Buffer.alloc(M.HISTORY_MAX_BYTES + 1, 32) } }, 'candidate-oversize'],
    [{ candidate: { ledgerBytes: f.snaps.ledger[1], historyBytes: f.historyBytes } }, 'candidate-invalid'],
    [{ anchors: { ledger: f.la(f.snaps.ledger[1]), history: f.ha(f.historyBytes) } }, 'candidate-invalid'],
    [{ domain: { householdId: 'household-' + 'e'.repeat(32), ledgerNamespace: f.ns } }, 'candidate-invalid'],
    [{ schema: 'pg_catalog' }, 'input-malformed'], [{ scope: 'Bad Scope' }, 'input-malformed'],
    [{ extra: 1 }, 'input-malformed'],
  ];
  for (const [o, reason] of cases) {
    const s = makeSession(makeDb());
    assert.deepEqual({ ...(await M.installRestoreCandidate({ ...f.base(s), ...o })) }, { status: 'refused', reason }, reason);
    assert.equal(s.log.length, 0);
  }
  // exact boundary: ledger at the cap is NOT refused as oversize (fails validation instead)
  const s = makeSession(makeDb());
  assert.equal((await M.installRestoreCandidate({ ...f.base(s), candidate: { ledgerBytes: Buffer.alloc(M.LEDGER_MAX_BYTES, 32), historyBytes: f.historyBytes } })).reason, 'candidate-invalid');
});

test('session claim: invalid session refused; a maintenance session is single-use across install and verify', async () => {
  const f = await world();
  assert.equal((await M.installRestoreCandidate(f.base({ query() {}, on() {} }))).reason, 'session-invalid');
  const s = makeSession(makeDb());
  assert.equal((await M.installRestoreCandidate(f.base(s))).status, 'installed-unverified');
  assert.deepEqual({ ...(await M.installRestoreCandidate(f.base(s))) }, { status: 'refused', reason: 'session-already-claimed' });
  assert.deepEqual({ ...(await M.verifyRestoreInstall({ ...f.base(s), pin: f.pin })) }, { status: 'refused', reason: 'session-already-claimed' });
});

test('incumbent over the existing quarantine limit is refused and rolled back (never truncated or crammed)', async () => {
  const f = await world(); const big = Buffer.alloc(M.QUARANTINE_MAX_BYTES + 1, 1);
  const db = makeDb({ terminal: { h: big, c: Buffer.from('cp') } }); const s = makeSession(db);
  assert.deepEqual({ ...(await M.installRestoreCandidate(f.base(s))) }, { status: 'refused', reason: 'incumbent-unbounded' });
  assert.ok(s.log.includes('ROLLBACK')); assert.equal(db.quarantine.size, 0); assert.ok(db.terminal.get(SCOPE).h.equals(big));
});

test('quarantine collision and quarantine insert failure: no replacement, nothing committed', async () => {
  const f = await world();
  const db = makeDb({ head: Buffer.from('incumbent') });
  const s = makeSession(db, { after: (t) => /^SELECT 1 AS present/.test(t) ? { command: 'SELECT', rows: [{ present: 1 }], rowCount: 1 } : undefined });
  assert.deepEqual({ ...(await M.installRestoreCandidate(f.base(s))) }, { status: 'refused', reason: 'quarantine-collision' });
  assert.ok(s.log.includes('ROLLBACK')); assert.equal(s.log.some(t => /doc_head \(scope/.test(t)), false);
  assert.ok(db.head.get(SCOPE).equals(Buffer.from('incumbent')));
  const db2 = makeDb({ head: Buffer.from('incumbent') });
  const s2 = makeSession(db2, { before: (t) => { if (/^INSERT INTO "atlas_settle"\.quarantine/.test(t)) throw new Error('permission denied'); } });
  const r2 = await M.installRestoreCandidate(f.base(s2));
  assert.deepEqual({ ...r2 }, { status: 'refused', reason: 'aborted-before-commit', cause: 'session-lost' });
  assert.equal(s2.log.includes('COMMIT'), false); assert.equal(s2.retired, 1);
  assert.ok(db2.head.get(SCOPE).equals(Buffer.from('incumbent'))); assert.equal(db2.quarantine.size, 0);
});

test('malformed acknowledgements before COMMIT abort without commit (tags, rowCounts, envelopes, pid swap)', async () => {
  const f = await world();
  const seed = () => makeDb({ head: Buffer.from('h'), staged: Buffer.from('s'), terminal: { h: Buffer.from('x'), c: Buffer.from('y') } });
  const muts = [
    [t => /^BEGIN/.test(t), () => ({ command: 'SELECT', rows: [] }), 'protocol-malformed'],
    [t => /doc_head \(scope/.test(t), () => ({ command: 'INSERT', rows: [], rowCount: 0 }), 'protocol-malformed'],
    [t => /^UPDATE/.test(t), () => ({ command: 'UPDATE', rows: [], rowCount: 2 }), 'protocol-malformed'],
    [t => /^DELETE FROM "atlas_settle"\.doc_staged/.test(t), () => ({ command: 'DELETE', rows: [], rowCount: 0 }), 'protocol-malformed'],
    [t => /quarantine \(/.test(t), () => ({ command: 'UPDATE', rows: [], rowCount: 1 }), 'protocol-malformed'],
    [t => /^SELECT bytes FROM "atlas_settle"\.doc_head/.test(t), () => ({ command: 'SELECT', rows: [{ bytes: 'str' }] }), 'protocol-malformed'],
    [t => /^SELECT bytes FROM "atlas_settle"\.journal/.test(t), () => ({ command: 'SELECT', rows: [{ bytes: Buffer.from('a') }, { bytes: Buffer.from('b') }] }), 'protocol-malformed'],
    [t => /^DELETE FROM "atlas_settle"\.journal/.test(t), () => null, 'protocol-malformed'],
  ];
  for (const [match, reply, cause] of muts) {
    const db = seed(); const s = makeSession(db, { after: (t) => match(t) ? reply() : undefined });
    const r = await M.installRestoreCandidate(f.base(s));
    assert.deepEqual({ ...r }, { status: 'refused', reason: 'aborted-before-commit', cause }, String(match));
    assert.equal(s.log.includes('COMMIT'), false); assert.equal(s.retired, 1);
    assert.ok(db.head.get(SCOPE).equals(Buffer.from('h')), 'snapshot restored on abort');
  }
  // backend pid swap between lock and transaction
  let calls = 0; const db = seed();
  const s = makeSession(db, { after: (t) => /pg_backend_pid/.test(t) && ++calls === 2 ? { command: 'SELECT', rows: [{ pid: 1 }] } : undefined });
  assert.deepEqual({ ...(await M.installRestoreCandidate(f.base(s))) }, { status: 'refused', reason: 'aborted-before-commit', cause: 'backend-changed' });
});

test('COMMIT outcome: lost/rejected/unaffirmed acknowledgement is unknown, never retried; session loss event mid-transaction aborts', async () => {
  const f = await world();
  for (const hook of [
    { before: t => { if (t === 'COMMIT') throw new Error('connection reset'); } },
    { after: t => t === 'COMMIT' ? { command: 'ROLLBACK', rows: [] } : undefined },
    { after: t => t === 'COMMIT' ? { rows: 'x' } : undefined },
    { after: (t, v, i, r, s) => { if (t === 'COMMIT') s.emit('end'); } },
  ]) {
    const s = makeSession(makeDb(), hook);
    assert.deepEqual({ ...(await M.installRestoreCandidate(f.base(s))) }, { status: 'unknown', reason: 'commit-unknown' });
    assert.equal(s.log.filter(t => t === 'COMMIT').length, 1, 'no retry'); assert.equal(s.retired, 1);
  }
  const db = makeDb({ head: Buffer.from('h') });
  const s = makeSession(db, { after: (t, v, i, r, ss) => { if (/quarantine \(/.test(t)) ss.emit('error'); } });
  assert.deepEqual({ ...(await M.installRestoreCandidate(f.base(s))) }, { status: 'refused', reason: 'aborted-before-commit', cause: 'session-lost' });
  assert.equal(s.log.includes('COMMIT'), false); assert.ok(db.head.get(SCOPE).equals(Buffer.from('h')));
});

test('no TC rollback-floor or domain-registry mutation, and no adapter/runtime/connection/auth/store importer', async () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(MODULE, 'utf8');
  const reqs = [...src.matchAll(/require\('([^']+)'\)/g)].map(m => m[1]).sort();
  assert.deepEqual(reqs, ['./settlement-evidence-restore-input', 'node:crypto']);
  assert.equal(/qualifySnapshot|registerDomain|process\.env/.test(src.replace(/^\s*\/\/.*$/gm, '')), false);
  const orig = { q: TC.qualifySnapshot, r: TC.registerDomain }; let touched = 0;
  TC.qualifySnapshot = (...a) => { touched++; return orig.q(...a); }; TC.registerDomain = (...a) => { touched++; return orig.r(...a); };
  try { const f = await world(); touched = 0; await M.installRestoreCandidate(f.base(makeSession(makeDb()))); assert.equal(touched, 0); }
  finally { TC.qualifySnapshot = orig.q; TC.registerDomain = orig.r; }
});

// ---------------- verify ----------------
async function installed(f, seed) {
  const db = makeDb(seed); assert.equal((await M.installRestoreCandidate(f.base(makeSession(db)))).status, 'installed-unverified'); return db;
}
test('fresh-session readback verifies exact pair/checkpoint, no residue, validator over readback, pin agreement; read-only', async () => {
  const f = await world(); const db = await installed(f, { head: Buffer.from('h'), journal: Buffer.from('j') });
  const s = makeSession(db);
  const r = await M.verifyRestoreInstall({ ...f.base(s), pin: f.pin });
  assert.equal(r.status, 'verified'); frozenDeep(r);
  assert.equal(r.ledger.pin, C.digest({ householdId, revision: 2, documentDigest: JSON.parse(f.ledgerBytes).digest }));
  assert.equal(writes(s.log).length, 0);
  assert.ok(s.log.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert.equal(s.retired, 1); assert.equal(Object.keys(r).some(k => /reopen|restored|authority/i.test(k)), false);
});

test('verify mismatches: residue, byte drift, missing rows, pin disagreement; invalid anchors refuse up front', async () => {
  const f = await world();
  const run = async (mutate, o = {}) => { const db = await installed(f); mutate(db); return { ...(await M.verifyRestoreInstall({ ...f.base(makeSession(db)), pin: f.pin, ...o })) }; };
  assert.deepEqual(await run(db => db.staged.set(SCOPE, Buffer.from('s'))), { status: 'mismatch', reason: 'staged-residue' });
  assert.deepEqual(await run(db => db.journal.set(SCOPE, Buffer.from('j'))), { status: 'mismatch', reason: 'journal-residue' });
  assert.deepEqual(await run(db => db.head.delete(SCOPE)), { status: 'mismatch', reason: 'head-missing' });
  assert.deepEqual(await run(db => db.terminal.delete(SCOPE)), { status: 'mismatch', reason: 'history-missing' });
  assert.deepEqual(await run(db => db.head.set(SCOPE, Buffer.from(f.snaps.ledger[1]))), { status: 'mismatch', reason: 'head-mismatch' });
  assert.deepEqual(await run(db => { const t = db.terminal.get(SCOPE); db.terminal.set(SCOPE, { h: Buffer.concat([t.h, Buffer.from(' ')]), c: t.c }); }), { status: 'mismatch', reason: 'history-mismatch' });
  assert.deepEqual(await run(db => { const t = db.terminal.get(SCOPE); db.terminal.set(SCOPE, { h: t.h, c: Buffer.from('{}') }); }), { status: 'mismatch', reason: 'checkpoint-mismatch' });
  assert.deepEqual(await run(() => {}, { pin: 'a'.repeat(64) }), { status: 'mismatch', reason: 'pin-mismatch' });
  // readback validator is exercised on READBACK bytes: a reader that returns the candidate head but the
  // double replaces the row with a re-ordered (still byte-different) copy is caught as head-mismatch above;
  // here, forcing the validator path: a session whose head readback equals candidate but whose history row
  // equals candidate too passes; changing only the anchor makes the candidate itself invalid (refused up front).
  assert.deepEqual(await run(() => {}, { anchors: { ledger: f.la(f.snaps.ledger[1]), history: f.ha(f.historyBytes) } }), { status: 'refused', reason: 'candidate-invalid' });
});

test('verify: lock held refuses; read loss/malformed/unaffirmed end is unknown; never writes', async () => {
  const f = await world(); const db = await installed(f); db.lockOwner = 4242;
  const s = makeSession(db);
  assert.deepEqual({ ...(await M.verifyRestoreInstall({ ...f.base(s), pin: f.pin })) }, { status: 'refused', reason: 'lock-held' });
  for (const [hook, reason] of [
    [{ before: t => { if (/terminal_history/.test(t)) throw new Error('x'); } }, 'session-lost'],
    [{ after: t => /doc_staged/.test(t) ? { command: 'SELECT', rows: [{ bytes: 1 }] } : undefined }, 'protocol-malformed'],
    [{ after: t => t === 'COMMIT' ? { command: 'ROLLBACK', rows: [] } : undefined }, 'protocol-malformed'],
  ]) {
    const db2 = await installed(f); const s2 = makeSession(db2, hook);
    assert.deepEqual({ ...(await M.verifyRestoreInstall({ ...f.base(s2), pin: f.pin })) }, { status: 'unknown', reason });
    assert.equal(writes(s2.log).length, 0); assert.equal(s2.retired, 1);
  }
});

// ---------------- #709 BLOCK repairs (failure-class regressions) ----------------
// Class 1: positive-looking result envelopes must carry the right command tag
// and an exactly-shaped validated row before lock acquisition or PID
// continuity is relied on. Class 2: every result envelope, row and column is
// captured exactly once; accessor properties are refused, never invoked twice.
const getterRow = (cols, valueFor) => {
  const row = {};
  for (const c of cols) { let n = 0; Object.defineProperty(row, c, { enumerable: true, get() { return valueFor(c, n++); } }); }
  return row;
};
function lockPidMutations() {
  // Each mutation counts its own PID queries: a counter shared across cases
  // let one case's queries shift which query the next case malformed.
  const pidNth = k => { let calls = 0; return t => /pg_backend_pid/.test(t) && ++calls === k; };
  const acquirePid = pidNth(1), continuityPid = pidNth(2), continuityPidAgain = pidNth(3);
  return [
    ['lock tag INSERT', { after: t => /try_advisory/.test(t) ? { command: 'INSERT', rows: [{ locked: true }], rowCount: 1 } : undefined }],
    ['lock tag missing', { after: t => /try_advisory/.test(t) ? { rows: [{ locked: true }] } : undefined }],
    ['lock row extra column', { after: t => /try_advisory/.test(t) ? { command: 'SELECT', rows: [{ locked: true, x: 1 }], rowCount: 1 } : undefined }],
    ['lock row accessor', { after: t => /try_advisory/.test(t) ? { command: 'SELECT', rows: [getterRow(['locked'], () => true)], rowCount: 1 } : undefined }],
    ['acquire pid tag UPDATE', { pidQuery: 1, after: (t, v, i, r, s) => acquirePid(t) ? { command: 'UPDATE', rows: [{ pid: s.pid }], rowCount: 1 } : undefined }],
    ['continuity pid tag missing', { pidQuery: 2, after: (t, v, i, r, s) => continuityPid(t) ? { rows: [{ pid: s.pid }] } : undefined }],
    ['continuity pid extra column', { pidQuery: 3, after: (t, v, i, r, s) => continuityPidAgain(t) ? { command: 'SELECT', rows: [{ pid: s.pid, y: 2 }], rowCount: 1 } : undefined }],
    ['envelope rows accessor', { after: (t, v, i, r) => /try_advisory/.test(t) ? Object.defineProperty({ command: 'SELECT', rowCount: 1 }, 'rows', { enumerable: true, get: () => r.rows }) : undefined }],
  ].map(([name, hook]) => {
    // Record whether the malformed envelope was actually served: a mutation
    // that never fires proves nothing about the step it names.
    // PID mutations also record which of this run's PID queries they hit.
    const counted = { ...hook, fired: 0, pidSeen: 0, firedAtPid: [] };
    counted.after = (...args) => {
      const isPid = /pg_backend_pid/.test(args[0]);
      if (isPid) counted.pidSeen++;
      const out = hook.after(...args);
      if (out !== undefined) { counted.fired++; if (isPid) counted.firedAtPid.push(counted.pidSeen); }
      return out;
    };
    return [name, counted];
  });
}

test('#709 repair 1: malformed positive lock/PID envelopes never yield installed-unverified (install aborts before COMMIT)', async () => {
  const f = await world();
  for (const [name, hook] of lockPidMutations()) {
    const db = makeDb({ head: Buffer.from('incumbent') }); const s = makeSession(db, hook);
    const r = await M.installRestoreCandidate(f.base(s));
    assert.deepEqual({ ...r }, { status: 'refused', reason: 'aborted-before-commit', cause: 'protocol-malformed' }, name);
    assert.ok(hook.fired >= 1, name + ': the malformed envelope was served');
    if (hook.pidQuery) assert.deepEqual(hook.firedAtPid, [hook.pidQuery], name + ': malformed the intended PID query');
    assert.equal(s.log.includes('COMMIT'), false, name); assert.equal(s.retired, 1, name);
    assert.ok(db.head.get(SCOPE).equals(Buffer.from('incumbent')), name); assert.equal(db.quarantine.size, 0, name);
  }
});

test('#709 repair 1: malformed positive lock/PID envelopes never yield verified (readback is unknown)', async () => {
  const f = await world();
  for (const [name, hook] of lockPidMutations()) {
    const db = await installed(f); const s = makeSession(db, hook);
    const r = await M.verifyRestoreInstall({ ...f.base(s), pin: f.pin });
    assert.deepEqual({ ...r }, { status: 'unknown', reason: 'protocol-malformed' }, name);
    assert.ok(hook.fired >= 1, name + ': the malformed envelope was served');
    if (hook.pidQuery) assert.deepEqual(hook.firedAtPid, [hook.pidQuery], name + ': malformed the intended PID query');
    assert.equal(writes(s.log).length, 0, name); assert.equal(s.retired, 1, name);
  }
});

const ARTIFACT_READS = [
  ['head', /^SELECT bytes FROM "atlas_settle"\.doc_head/, ['bytes']],
  ['staged', /^SELECT bytes FROM "atlas_settle"\.doc_staged/, ['bytes']],
  ['journal', /^SELECT bytes FROM "atlas_settle"\.journal/, ['bytes']],
  ['history+checkpoint', /^SELECT history_bytes, checkpoint_bytes/, ['history_bytes', 'checkpoint_bytes']],
];

test('#709 repair 2: an accessor row (validate A, copy B) for every incumbent artifact is refused; nothing committed, A preserved', async () => {
  const f = await world();
  const A = Buffer.from('incumbent-A'), B = Buffer.from('different-B');
  for (const [name, re, cols] of ARTIFACT_READS) {
    const db = makeDb({ head: A, staged: A, journal: A, terminal: { h: A, c: A } });
    const s = makeSession(db, { after: t => re.test(t) ? { command: 'SELECT', rows: [getterRow(cols, (c, n) => Buffer.from(n === 0 ? A : B))], rowCount: 1 } : undefined });
    const r = await M.installRestoreCandidate(f.base(s));
    assert.deepEqual({ ...r }, { status: 'refused', reason: 'aborted-before-commit', cause: 'protocol-malformed' }, name);
    assert.equal(s.log.includes('COMMIT'), false, name); assert.equal(db.quarantine.size, 0, name);
    assert.ok(db.head.get(SCOPE).equals(A) && db.terminal.get(SCOPE).h.equals(A), name);
    assert.equal([...db.quarantine.values()].some(q => q.bytes.equals(B)), false, name);
  }
});

test('#709 repair 2: readback refuses accessor rows/envelopes and extra columns for every artifact (never verified)', async () => {
  const f = await world();
  for (const [name, re, cols] of ARTIFACT_READS) {
    for (const [variant, reply] of [
      ['accessor row', r => ({ command: 'SELECT', rows: [getterRow(cols, c => Buffer.from(r.rows.length ? r.rows[0][c] : 'z'))], rowCount: 1 })],
      ['rows accessor', r => Object.defineProperty({ command: 'SELECT', rowCount: r.rows.length }, 'rows', { enumerable: true, get: () => r.rows })],
      ['command accessor', r => Object.defineProperty({ rows: r.rows, rowCount: r.rows.length }, 'command', { enumerable: true, get: () => 'SELECT' })],
      ['extra column', r => ({ command: 'SELECT', rows: [{ ...(r.rows[0] || Object.fromEntries(cols.map(c => [c, Buffer.from('z')]))), extra: Buffer.from('e') }], rowCount: 1 })],
    ]) {
      const db = await installed(f); const s = makeSession(db, { after: (t, v, i, r) => re.test(t) ? reply(r) : undefined });
      const out = await M.verifyRestoreInstall({ ...f.base(s), pin: f.pin });
      assert.deepEqual({ ...out }, { status: 'unknown', reason: 'protocol-malformed' }, name + ' ' + variant);
      assert.equal(writes(s.log).length, 0); assert.equal(s.retired, 1);
    }
  }
});

test('#709 repair 2: captured column bytes are owned; later mutation of the driver buffer cannot change quarantined or compared bytes', async () => {
  const f = await world();
  let driverBuf = null;
  const db = makeDb({ head: Buffer.from('incumbent') });
  const s = makeSession(db, {
    after: (t, v, i, r) => { if (/^SELECT bytes FROM "atlas_settle"\.doc_head/.test(t)) driverBuf = r.rows[0].bytes; },
    before: t => { if (/quarantine \(/.test(t) && driverBuf) driverBuf.fill(0x5a); },
  });
  assert.equal((await M.installRestoreCandidate(f.base(s))).status, 'installed-unverified');
  assert.ok([...db.quarantine.values()][0].bytes.equals(Buffer.from('incumbent')));
  // quarantine-presence probe is shape-checked too (extra column refused, never treated as a collision)
  const db2 = makeDb({ head: Buffer.from('incumbent') });
  const s2 = makeSession(db2, { after: t => /^SELECT 1 AS present/.test(t) ? { command: 'SELECT', rows: [{ present: 1, x: 1 }], rowCount: 1 } : undefined });
  assert.deepEqual({ ...(await M.installRestoreCandidate(f.base(s2))) }, { status: 'refused', reason: 'aborted-before-commit', cause: 'protocol-malformed' });
});
