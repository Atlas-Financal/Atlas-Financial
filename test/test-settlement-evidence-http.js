'use strict';

// Actual application/login/routes. Explicitly synthetic authority, acquisition,
// monotonic context and durable-memory adapters. No storage trial files, real
// credentials, external provider, database, deployment or production activation.
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createApplication, createPreactivationApplication } = require('../server');
const { createSettlementEvidenceStore } = require('../scripts/settlement-evidence-store');
const Forecast = require('../public/forecast');
const R = require('../scripts/settlement-evidence-resolver');
const householdId = 'household-' + 'a'.repeat(32);
const syntheticCredential = purpose => ['synthetic-only-http', purpose, crypto.randomBytes(24).toString('hex')].join('-');
const env = { SITE_PASSWORD: syntheticCredential('password'), SESSION_SECRET: syntheticCredential('signature-secret') };
const op = n => 'operation-' + n.toString(16).padStart(32, '0');
const clone = value => structuredClone(value);
function acquisitionFor(base) {
  const packet = clone(base.liveOverlay.currentPeriodActuals);
  packet.transactions = [{ id: 'synthetic-row', date: '2026-10-03', amount: 60,
    currency: 'cad', pending: false, categoryLabel: 'Groceries', merchantKnown: true,
    atlasAccountId: 'chequing-a', accountRole: 'household-cash',
    displayedPayee: 'Synthetic recorded club payment' }];
  packet.transactionWindow = { startDate: '2026-10-02', endDate: '2026-10-05', complete: true, hasMore: false, truncated: false };
  return { packet, plan: clone(base.plan),
    join: [{ localId: 'synthetic-row', providerAccountId: 'SYNTHETIC-ACCOUNT', transactionId: 'SYNTHETIC-TRANSACTION' }],
    map: { mappings: [{ providerAccountId: 'SYNTHETIC-ACCOUNT', canonical: { id: 'chequing-a', collection: 'cash' } }] } };
}
async function startWorld(active = true, options = {}) {
  // Test-only clock injection exercises the unchanged controller/store TTL.
  // The application's signed-cookie expiry continues to use its real clock.
  let syntheticClock = options.syntheticState?.clock ?? Date.now();
  const now = options.now || (options.nativeNegative ? () => syntheticClock : Date.now);
  const base = require('./fixtures/savings-daily-consumer-data')();
  base.plan.savingsEarmarks.pools[0].goalRefs = [{ kind: 'commitment', id: 'near' }];
  const w = { base, cell: { revision: 1, domain: 'synthetic-domain' }, authorized: true,
    readFailure: false, calls: { storage: 0, journal: 0, commit: 0, acquire: 0, base: 0 },
    hooks: {}, effects: clone(options.syntheticState?.effects || []), durable: { doc: null, staged: null, journal: null, pin: null, backups: new Map() } };
  w.acquisition = acquisitionFor(base);
  w.setClock = value => { syntheticClock = value; };
  w.historyCalls = clone(options.syntheticState?.historyCalls || { read: 0, append: 0 });
  if (options.syntheticState) {
    assert.equal(options.nativeNegative, true, 'restored synthetic state uses its original native mode');
    const saved = options.syntheticState;
    for (const key of ['doc', 'staged', 'journal']) w.durable[key] = saved[key] === null ? null : Buffer.from(saved[key], 'base64');
    w.durable.pin = clone(saved.pin);
    w.durable.backups = new Map(saved.backups.map(([key, entry]) => [key, { ...entry, bytes: Buffer.from(entry.bytes, 'base64') }]));
    w.cell = clone(saved.cell); Object.assign(w.calls, saved.calls);
  }
  let tail = Promise.resolve();
  const lock = { withLock(fn) { const value = tail.then(fn, fn); tail = value.catch(() => {}); return value; } };
  const d = w.durable;
  const read = (name, fn) => async (...args) => {
    w.calls.storage++;
    if (w.hooks.storageRead) await w.hooks.storageRead(name);
    return fn(...args);
  };
  const documentStore = {
    read: read('doc', () => d.doc && Buffer.from(d.doc)),
    readStaged: read('staged', () => d.staged && Buffer.from(d.staged)),
    async writeTemp(bytes) { w.effects.push('temp'); d.staged = Buffer.from(bytes); },
    async commitTemp() { w.effects.push('rename'); d.doc = d.staged; d.staged = null; },
    async discardTemp() { w.effects.push('discard'); d.staged = null; },
  };
  const journalStore = { read: read('journal', () => d.journal && Buffer.from(d.journal)),
    async write(value) {
      w.effects.push('journal'); w.calls.journal++; d.journal = Buffer.from(JSON.stringify(value));
      if (w.hooks.journalWrite) await w.hooks.journalWrite();
    },
    async clear() { w.effects.push('clear'); if (w.hooks.journalClear) await w.hooks.journalClear(); d.journal = null; } };
  const pinStore = { read: read('pin', () => d.pin && clone(d.pin)),
    async advance(expected, next) {
      w.effects.push('pin');
      if (expected === null ? d.pin !== null : !d.pin || expected.revision !== d.pin.revision || expected.digest !== d.pin.digest) return false;
      d.pin = clone(next); return true;
    } };
  const backupStore = { async put(revision, digest, bytes) {
    w.effects.push('backup');
    const entry = { revision, digest, artifactId: 'synthetic-' + revision };
    d.backups.set(digest, { ...entry, bytes: Buffer.from(bytes) }); return entry;
  }, async get(revision, digest) { const entry = d.backups.get(digest); return entry?.revision === revision ? Buffer.from(entry.bytes) : null; },
  async list() { return [...d.backups.values()].map(({ bytes, ...entry }) => entry); } };
  let nativeDependencies = {};
  if (options.nativeNegative) {
    // Explicit TEST-OWNED positive history genesis, never runtime fallback.
    // This reuses D1's synthetic encoder; no new production transport exists.
    const { encoded } = require('./test-settlement-evidence-terminal-certificate');
    const saved = options.syntheticState;
    w.exclusionDomain = clone(saved?.domain || {
      ledgerNamespace: 'ledger-' + crypto.randomBytes(16).toString('hex'),
      serializationAuthority: 'authority-' + crypto.randomBytes(16).toString('hex'),
      historyAuthority: 'authority-' + crypto.randomBytes(16).toString('hex') });
    if (saved) {
      d.historyBytes = Buffer.from(saved.historyBytes, 'base64'); d.checkpoint = clone(saved.checkpoint);
    } else Object.assign(d, encoded([], householdId, w.exclusionDomain.ledgerNamespace));
    const terminalHistory = {
      async readSnapshot() {
        w.historyCalls.read++;
        if (w.hooks.historyRead) await w.hooks.historyRead();
        return { historyBytes: d.historyBytes && Buffer.from(d.historyBytes), checkpoint: d.checkpoint && clone(d.checkpoint) };
      },
      async compareAndAppend(input) {
        w.historyCalls.append++;
        const perform = () => {
          if (!require('node:util').isDeepStrictEqual(input.expectedCheckpoint, d.checkpoint)) return false;
          const next = encoded([...JSON.parse(d.historyBytes).records, clone(input.certificate)], householdId, w.exclusionDomain.ledgerNamespace);
          d.historyBytes = next.historyBytes; d.checkpoint = next.checkpoint; return true;
        };
        return w.hooks.historyAppend ? w.hooks.historyAppend(perform, input) : perform();
      }
    };
    nativeDependencies = { exclusionDomain: w.exclusionDomain, terminalHistory };
  }
  const constructStore = () => createSettlementEvidenceStore({ householdId, documentStore, journalStore, pinStore, backupStore,
    quarantine: { async put() { throw new Error('synthetic quarantine forbidden'); } }, lock, now, ...nativeDependencies });
  w.store = constructStore();
  if (active && !options.syntheticState) assert.equal((await w.store.bootstrap()).status, 'bootstrapped');
  const server = w.server = http.createServer();
  await new Promise(resolve => server.listen(options.port || 0, '127.0.0.1', resolve));
  w.origin = 'http://127.0.0.1:' + server.address().port;
  w.contextReader = () => ({ contextRevision: w.cell.revision, domain: w.cell.domain });
  w.syntheticAcquire = async reader => {
    w.calls.acquire++;
    const captured = clone(reader());
    const acquisition = clone(w.acquisition);
    return { ...acquisition, witness() {
      const current = reader();
      return current.contextRevision === captured.contextRevision && current.domain === captured.domain;
    } };
  };
  w.dependency = { householdId, origin: w.origin, now, contextReader: w.contextReader,
    async authorize(context) {
      if (w.hooks.authorize) await w.hooks.authorize(context);
      if (!w.authorized) throw new Error('synthetic revoked');
      return { householdId, actorId: context.actorId };
    },
    acquire: reader => w.syntheticAcquire(reader),
    store: w.store,
    async commitAdmitted(input, witness) {
      w.calls.commit++;
      if (w.hooks.admission) await w.hooks.admission();
      return w.store.commitAdmitted(input, witness);
    },
    async readBase() { w.calls.base++; if (w.hooks.base) await w.hooks.base(); return w.base; },
    async readDocument() {
      if (w.readFailure) throw new Error('SYNTHETIC-PRIVATE-READ-ERROR');
      if (w.hooks.document) await w.hooks.document();
      return documentStore.read();
    },
    async readPin() {
      if (w.readFailure) throw new Error('SYNTHETIC-PRIVATE-PIN-ERROR');
      if (w.hooks.pin) await w.hooks.pin();
      return pinStore.read();
    } };
  // RAW synthetic complete base only. The actual application constructor must
  // compose authorized ordinary browser settlement reads; this fixture must
  // never attach settlement evidence on its behalf.
  const constructionEnv = { ...env, ...options.env };
  let mode = options.preactivationOnly ? 'preactivation-only' : active ? 'active' : 'disabled';
  w.recreate = (next = mode) => {
    assert.ok(['active', 'disabled', 'preactivation-only'].includes(next)); mode = next;
    const enabled = mode === 'active';
    const construct = mode === 'preactivation-only' ? createPreactivationApplication : createApplication;
    const app = construct({ env: constructionEnv, baseSource: async () => {
      if (w.hooks.rawBase) await w.hooks.rawBase();
      return w.base;
    },
      ...(enabled ? { settlement: w.dependency } : {}) });
    server.removeAllListeners('request'); server.on('request', app); w.app = app;
  };
  w.recreate();
  w.recreateStore = () => { w.store = constructStore(); w.dependency.store = w.store; w.recreate(); };
  w.snapshot = () => {
    assert.equal(options.nativeNegative, true);
    return { clock: now(), domain: clone(w.exclusionDomain), historyBytes: d.historyBytes.toString('base64'),
      checkpoint: clone(d.checkpoint), historyCalls: clone(w.historyCalls), effects: [...w.effects], cell: clone(w.cell), calls: clone(w.calls),
      ...Object.fromEntries(['doc', 'staged', 'journal'].map(key => [key, d[key] && d[key].toString('base64')])),
      pin: clone(d.pin), backups: [...d.backups].map(([key, e]) => [key, { ...e, bytes: e.bytes.toString('base64') }]) };
  };
  w.login = async () => {
    const response = await fetch(w.origin + '/login', { method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: constructionEnv.SITE_PASSWORD }) });
    assert.equal(response.status, 302);
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
    return response.headers.get('set-cookie').split(';')[0];
  };
  w.cookie = await w.login();
  w.raw = (route, body, overrides = {}) => fetch(w.origin + '/settlement/' + route, {
    method: 'POST', headers: { Cookie: w.cookie, Origin: w.origin, 'Content-Type': 'application/json',
      'X-Atlas-Settlement': 'same-origin', ...overrides.headers }, body: JSON.stringify(body), ...overrides,
  });
  w.post = async (route, body) => {
    const response = await w.raw(route, body); assert.equal(response.status, 200, route); return response.json();
  };
  w.selection = async () => {
    const c = await w.post('selections', {}); assert.equal(c.status, 'available');
    return { transaction: c.transactions[0].handle, commitment: c.commitments[0].handle };
  };
  w.prepare = async (n = 1) => w.post('prepare', { operationId: op(n), selection: await w.selection(), assignedCents: 2500 });
  w.confirm = p => w.post('confirm', { operationId: p.operationId, previewToken: p.previewToken, confirmed: true });
  w.close = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  if (!options.syntheticState) { w.calls.storage = 0; w.effects.length = 0; }
  return w;
}
module.exports = { startWorld, op, env, householdId };

async function syntheticRecord(w, n, command, actorId) {
  const p = await w.store.prepare({ actorId, operationId: op(n), command });
  assert.ok(p.preview);
  const r = await w.store.commitWithoutRecovery({ actorId, preview: p.preview,
    confirmationDigest: p.confirmationDigest });
  assert.equal(r.status, 'committed'); return r;
}
async function withdrawal(w, n = 10) {
  const c = await w.post('assignments', {}); assert.equal(c.status, 'available');
  assert.ok(c.assignments.length);
  return w.post('prepare-withdrawal', { operationId: op(n), assignmentHandle: c.assignments[0].handle });
}
module.exports.syntheticRecord = syntheticRecord;
module.exports.withdrawal = withdrawal;

// Deterministic synthetic competitor, using the real store/contract. It never
// fabricates a successful prepare, journal or receipt. Shared by HTTP/browser
// and selected controller proofs; no runtime seam or production writer added.
async function appendCompetingRecord(w, input, options = {}, prepare = w.store.prepare) {
  const doc = JSON.parse(w.durable.doc);
  const source = input.command.kind === 'retract'
    ? doc.operations.find(o => o.operationId === input.command.targetOperationId).command : input.command;
  const actorId = 'session-' + 'e'.repeat(64);
  const operationId = options.sameId ? input.operationId : options.competingOperationId || op(900);
  const command = { ...source, goalId: 'commitment:' + w.base.plan.commitments[1].id, assignedCents: 100 };
  const p = await prepare({ actorId, operationId, command }); assert.ok(p.preview);
  if (options.journal) w.hooks.journalWrite = async () => { throw new Error('synthetic lost journal acknowledgement'); };
  let receipt;
  try { receipt = await w.store.commitWithoutRecovery({ actorId, preview: p.preview, confirmationDigest: p.confirmationDigest }); }
  finally { if (options.journal) delete w.hooks.journalWrite; }
  assert.equal(receipt.status, options.journal ? 'unknown' : 'committed');
  return { actorId, operationId, receipt, doc: Buffer.from(w.durable.doc), pin: JSON.stringify(w.durable.pin),
    journal: w.durable.journal && Buffer.from(w.durable.journal), journalWrites: w.calls.journal };
}
function armProbeCompetition(w, operationId, options = {}) {
  const prepare = w.store.prepare; let armed = true;
  const control = { probeEntered: false, successfulProbe: false };
  w.store.prepare = async input => {
    const target = armed && input.operationId === operationId;
    if (target) {
      armed = false; control.probeEntered = true;
      control.competing = await appendCompetingRecord(w, input, options, prepare);
    }
    const result = await prepare(input);
    if (target) control.successfulProbe = !!result.preview;
    return result;
  };
  return control;
}
module.exports.appendCompetingRecord = appendCompetingRecord;
module.exports.armProbeCompetition = armProbeCompetition;


/* TEST-ONLY process replacement. State is retained by the parent over IPC;
 * no production persistence/transport or runtime endpoint is introduced. */
async function startChildWorld(options = {}) {
  const { fork } = require('node:child_process');
  let child, world, sequence = 0;
  const pending = new Map();
  const rpc = (kind, value) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); child.send({ id, kind, value });
  });
  async function launch(state, port) {
    child = fork(__filename, ['--synthetic-negative-child'], { windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', b => { stderr += b.toString().slice(0, 1000); });
    child.on('message', reply => {
      const waiter = pending.get(reply.id); if (!waiter) return; pending.delete(reply.id);
      if (reply.error) waiter.reject(Error(reply.error)); else waiter.resolve(reply.value);
    });
    child.on('exit', code => {
      for (const [id, p] of pending) { p.reject(Error('synthetic child exited ' + code + ': ' + stderr)); pending.delete(id); }
    });
    const ready = await rpc('start', { ...options, nativeNegative: true, syntheticState: state, port, env });
    if (!world) {
      world = { ...ready,
        setClock: value => rpc('clock', value),
        async snapshot() { const state = await rpc('snapshot'); Object.assign(world.calls, state.calls);
          Object.assign(world.historyCalls, state.historyCalls); world.effects = state.effects; return state; },
        async restart() {
          const state = await world.snapshot(), port = new URL(world.origin).port;
          await world.stop(); await launch(state, Number(port)); return state;
        },
        async stop() {
          const stopped = new Promise(resolve => child.once('exit', resolve));
          await rpc('close'); await stopped;
        },
        close: () => world.stop(),
        raw: (name, body, opts = {}) => fetch(world.origin + '/settlement/' + name, {
          method:'POST', headers:{Cookie:world.cookie,Origin:world.origin,
            'Content-Type':'application/json','X-Atlas-Settlement':'same-origin', ...opts.headers},
          body:JSON.stringify(body) }),
        async post(name, body) { const r=await world.raw(name,body);assert.equal(r.status,200);return r.json(); }
      };
    } else {
      assert.equal(ready.origin, world.origin, 'original browser origin survives replacement');
      assert.notEqual(ready.processId, world.processId, 'a different actual child owns the recreated application');
      world.processId = ready.processId;
    }
    return world;
  }
  return launch();
}
module.exports.startChildWorld = startChildWorld;
if (require.main === module && process.argv.includes('--synthetic-negative-child')) {
  let fixture;
  process.on('message', async request => {
    try {
      let value;
      if (request.kind === 'start') {
        fixture = await startWorld(true, request.value);
        if (request.value.loseSealAck) fixture.hooks.historyAppend = perform => { perform(); throw Error('synthetic lost store acknowledgement'); };
        value = { origin: fixture.origin, cookie: fixture.cookie, calls: fixture.calls, historyCalls: fixture.historyCalls, effects: fixture.effects, processId: process.pid };
      } else if (request.kind === 'clock') fixture.setClock(request.value);
      else if (request.kind === 'snapshot') value = fixture.snapshot();
      else if (request.kind === 'close') await fixture.close();
      else throw Error('unknown synthetic command');
      process.send({ id: request.id, value }, () => { if (request.kind === 'close') process.exit(0); });
    } catch (error) { process.send({ id: request.id, error: error.message }); }
  });
}

if (require.main === module && !process.argv.includes('--synthetic-negative-child')) {
  const test = require('node:test');



  test('B3 Addendum A lost store acknowledgement blocks same-instance lookup until reconstruction',async t=>{
    const w=await startWorld(true,{nativeNegative:true});t.after(w.close);const p=await w.prepare();w.setClock(p.expiresAt);
    w.hooks.historyAppend=perform=>{perform();throw Error('synthetic lost store acknowledgement');};
    assert.equal((await w.post('confirm',{operationId:p.operationId,previewToken:p.previewToken,generation:p.generation,confirmed:true})).status,'unknown');
    const before=w.snapshot(),reads=w.historyCalls.read;
    assert.equal((await w.post('outcome',{operationId:p.operationId,generation:p.generation})).status,'unknown');
    assert.equal(w.historyCalls.read,reads,'terminal owner blocks the native lookup');
    assert.equal((await w.prepare(2)).reason,'outcome-unresolved');
    w.recreateStore();
    assert.deepEqual(await w.post('outcome',{operationId:p.operationId,generation:p.generation}),
      {status:'not-applied',operationId:p.operationId,generation:p.generation});
    const after=w.snapshot();assert.equal(after.doc,before.doc);assert.equal(after.historyBytes,before.historyBytes);
    assert.equal(after.historyCalls.append,1);assert.deepEqual(after.effects,[]);
  });

  async function b3Sealed(w) {
    const p = await w.prepare(); w.setClock(p.expiresAt);
    assert.equal((await w.post('confirm', { operationId:p.operationId, previewToken:p.previewToken,
      generation:p.generation, confirmed:true })).status,'not-applied'); return p;
  }
  test('B3 outcome shape actor generation and publication remain independently bounded',async t=>{
    const w=await startWorld(true,{nativeNegative:true});t.after(w.close);const p=await b3Sealed(w);
    assert.equal((await w.post('outcome',{operationId:p.operationId})).status,'unknown');
    assert.equal((await w.post('publication',{operationId:p.operationId})).status,'unknown');
    assert.equal((await w.raw('publication',{operationId:p.operationId,generation:p.generation})).status,400);
    for(const body of [{operationId:p.operationId,generation:null},{operationId:p.operationId,generation:'bad'},
      {operationId:p.operationId,generation:p.generation,actorId:'session-'+'f'.repeat(64)}])
      assert.equal((await w.raw('outcome',body)).status,400);
    assert.equal((await w.post('outcome',{operationId:p.operationId,generation:'generation-'+'f'.repeat(32)})).status,'unknown');
    const owner=w.cookie;w.cookie=await w.login();
    assert.equal((await w.post('outcome',{operationId:p.operationId,generation:p.generation})).status,'unknown');
    w.cookie=owner;
    assert.deepEqual(await w.post('outcome',{operationId:p.operationId,generation:p.generation}),
      {status:'not-applied',operationId:p.operationId,generation:p.generation});
    assert.equal(w.calls.commit,0);assert.equal(w.calls.journal,0);assert.equal(w.historyCalls.append,1);assert.deepEqual(w.effects,[]);
  });
  for(const fault of ['unreadable','missing','torn','rollback','ledger-pin','journal','coexistence']){
    test('B3 qualified lookup refuses '+fault+' without mutation',async t=>{
      const w=await startWorld(true,{nativeNegative:true});t.after(w.close);const p=await b3Sealed(w);
      if(fault==='unreadable')w.hooks.historyRead=()=>{throw Error('synthetic history outage');};
      if(fault==='missing')w.durable.historyBytes=null;
      if(fault==='torn')w.durable.checkpoint.digest='f'.repeat(64);
      if(fault==='rollback')Object.assign(w.durable,require('./test-settlement-evidence-terminal-certificate').encoded([],householdId,w.exclusionDomain.ledgerNamespace));
      if(fault==='ledger-pin')w.durable.pin.digest='f'.repeat(64);
      if(fault==='journal')w.durable.journal=Buffer.from('{}');
      if(fault==='coexistence'){
        // Deliberately impossible under gated writers: qualify fail-closed on
        // independently forged coexistence, never grant either proof/receipt.
        const source=await startWorld();try{
          source.cookie=w.cookie; // Same synthetic signing authority and actor.
          const other=await source.prepare();assert.equal((await source.confirm(other)).status,'committed');
          w.durable.doc=Buffer.from(source.durable.doc);w.durable.pin=clone(source.durable.pin);
        }finally{await source.close();}
      }
      const before={doc:Buffer.from(w.durable.doc),journal:w.durable.journal&&Buffer.from(w.durable.journal),
        history:w.durable.historyBytes&&Buffer.from(w.durable.historyBytes),pin:clone(w.durable.pin),append:w.historyCalls.append};
      const r=await w.post('outcome',{operationId:p.operationId,generation:p.generation});
      assert.equal(r.status,'unknown');assert.ok(w.durable.doc.equals(before.doc));
      assert.deepEqual(w.durable.journal,before.journal);assert.deepEqual(w.durable.historyBytes,before.history);
      assert.deepEqual(w.durable.pin,before.pin);assert.equal(w.historyCalls.append,before.append);assert.equal(w.calls.journal,0);assert.deepEqual(w.effects,[]);
    });
  }
  for(const expiry of ['authorization','cookie']){
    test('B3 '+expiry+' expiry across native lookup suppresses proof',async t=>{
      const w=await startWorld(true,{nativeNegative:true});t.after(w.close);const p=await b3Sealed(w);
      let entered,release;const seen=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
      w.hooks.historyRead=async()=>{entered();await gate;};
      const originalNow=Date.now;
      try{
        const pending=w.raw('outcome',{operationId:p.operationId,generation:p.generation});await seen;
        if(expiry==='authorization')w.authorized=false;
        else {const payload=JSON.parse(Buffer.from(w.cookie.split('=')[1].split('.')[0],'base64url'));
          Date.now=()=>payload.exp+1;}
        release();const response=await pending;assert.equal(response.status,503);
        assert.deepEqual(await response.json(),{status:'unavailable'});
        assert.equal(w.historyCalls.append,1);assert.equal(w.calls.journal,0);
      }finally{Date.now=originalNow;release();}
    });
  }
  test('B3 actual child replacement preserves same-actor negative history without replay',async t=>{
    const w=await startChildWorld();t.after(w.close);
    const s=await w.post('selections',{}),id=op(777),p=await w.post('prepare',{
      operationId:id,selection:{transaction:s.transactions[0].handle,commitment:s.commitments[0].handle},assignedCents:2500});
    await w.setClock(p.expiresAt);
    assert.equal((await w.post('confirm',{operationId:id,previewToken:p.previewToken,generation:p.generation,confirmed:true})).status,'not-applied');
    const cookie=w.cookie,before=await w.restart();assert.equal(w.cookie,cookie);
    assert.deepEqual(await w.post('outcome',{operationId:id,generation:p.generation}),
      {status:'not-applied',operationId:id,generation:p.generation});
    const after=await w.snapshot();assert.equal(after.doc,before.doc);assert.equal(after.historyBytes,before.historyBytes);
    assert.equal(after.historyCalls.append,1);assert.equal(after.calls.commit,0);assert.equal(after.calls.journal,0);assert.deepEqual(after.effects,[]);
  });

  test('B3 qualified negative outcome survives application recreation without a write', async t => {
    const w = await startWorld(true, { nativeNegative: true }); t.after(w.close);
    const p = await w.prepare(); w.setClock(p.expiresAt);
    const result = await w.post('confirm', { operationId: p.operationId, previewToken: p.previewToken, generation: p.generation, confirmed: true });
    assert.equal(result.status, 'not-applied'); assert.equal(w.historyCalls.append, 1);
    const before = Buffer.from(w.durable.doc), history = Buffer.from(w.durable.historyBytes);
    w.recreateStore();
    const response = await w.raw('outcome', { operationId: p.operationId, generation: p.generation });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'not-applied', operationId: p.operationId, generation: p.generation });
    assert.ok(w.durable.doc.equals(before)); assert.ok(w.durable.historyBytes.equals(history));
    assert.equal(w.calls.commit, 0); assert.equal(w.calls.journal, 0); assert.equal(w.historyCalls.append, 1);
  });

  const correlatedConfirm = (w, p, overrides = {}) => w.post('confirm', {
    operationId: p.operationId, previewToken: p.previewToken, generation: p.generation, confirmed: true, ...overrides });
  const negative = p => ({ status: 'not-applied', operationId: p.operationId,
    previewToken: p.previewToken, generation: p.generation });
  const registrationGate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  async function capturedHttpWorld(t) {
    const w = await startWorld(); t.after(w.close); let capability, registrations = 0, reconciliations = 0;
    w.dependency.registerRecovery = value => { registrations++; capability = value; };
    w.recreate(); assert.equal(typeof capability, 'function', 'actual HTTP construction registers recovery');
    const inspect = w.store.inspectAttempt, reconcile = w.store.reconcile, inspections = [];
    w.store.inspectAttempt = async input => {
      const record = { input: structuredClone(input) }; inspections.push(record);
      const result = await inspect(input); record.result = structuredClone(result); return result;
    };
    w.store.reconcile = async () => { reconciliations++; return reconcile(); };
    return { w, capability, inspections, registrations: () => registrations, reconciliations: () => reconciliations };
  }
  async function committedHttpUncertainty(w) {
    const p = await w.prepare(); let revoked = false;
    w.hooks.authorize = async () => {
      if (!revoked && w.calls.commit && JSON.parse(w.durable.doc).operations.some(o => o.operationId === p.operationId)) {
        revoked = true; w.authorized = false; w.cell.revision++;
      }
    };
    const response = await w.raw('confirm', { operationId: p.operationId, previewToken: p.previewToken,
      generation: p.generation, confirmed: true });
    assert.equal(response.status, 503, 'actual commit cannot deliver through failed postauthorization');
    delete w.hooks.authorize; return p;
  }
  async function nextHttpRequest(w, n = 2) {
    const c = await w.post('selections', {});
    return { operationId: op(n), selection: { transaction: c.transactions[0].handle, commitment: c.commitments[1].handle }, assignedCents: 100 };
  }
  test('HTTP recovery registration captures one synchronous private noargument capability per construction', async t => {
    const w = await startWorld(); t.after(w.close);
    let calls = 0, capability, receiver, argumentsCount, returnObserved = false;
    w.dependency.registerRecovery = function (value) {
      calls++; capability = value; receiver = this; argumentsCount = arguments.length;
      return { then() { returnObserved = true; throw new Error('registrar return must be ignored'); } };
    };
    w.recreate();
    assert.equal(calls, 1, 'HTTP construction must forward the existing registrar');
    assert.equal(typeof capability, 'function'); assert.equal(capability.length, 0);
    assert.equal(receiver, undefined, 'registrar is forwarded unchanged, not rebound to dependency');
    assert.equal(argumentsCount, 1); assert.deepEqual(await capability(), { status: 'idle' });
    await w.post('selections', {}); assert.equal(calls, 1, 'requests reuse the constructed controller');
    assert.equal(returnObserved, false, 'return/thenable is not awaited or inspected');
    const previous = capability; w.recreate(); assert.equal(calls, 2); assert.notEqual(capability, previous);
    assert.deepEqual(await capability(), { status: 'idle' });
  });
  test('HTTP recovery registration optional invalid and synchronously throwing registrars preserve controller semantics', async t => {
    const w = await startWorld(); t.after(w.close);
    w.dependency.registerRecovery = undefined; assert.doesNotThrow(() => w.recreate());
    for (const value of [null, false, 1, 'invalid', {}, []]) {
      w.dependency.registerRecovery = value;
      assert.throws(() => w.recreate(), /incomplete trusted dependencies/);
    }
    const failure = new Error('synthetic registrar refusal');
    w.dependency.registerRecovery = () => { throw failure; };
    assert.throws(() => w.recreate(), error => error === failure, 'synchronous registrar error is not swallowed');
  });
  test('HTTP recovery registration keeps async return values ignored without changing capture timing', async t => {
    const w = await startWorld(); t.after(w.close); let capability, finished = false;
    w.dependency.registerRecovery = async value => { capability = value; await Promise.resolve(); finished = true; return 'ignored'; };
    w.recreate(); assert.equal(typeof capability, 'function'); assert.equal(finished, false);
    await Promise.resolve(); assert.equal(finished, true); assert.deepEqual(await capability(), { status: 'idle' });
  });
  test('HTTP recovery registration exposes no controller or HTTP maintenance surface', async t => {
    const a = await capturedHttpWorld(t), { w } = a;
    for (const route of ['recover', 'recovery', 'reconcile', 'reset', 'registerRecovery']) {
      assert.equal((await w.raw(route, {})).status, 404);
      assert.equal((await fetch(w.origin + '/settlement/' + route, { headers: { Cookie: w.cookie } })).status, 405);
    }
    const capability = await fetch(w.origin + '/settlement/capability', { headers: { Cookie: w.cookie } });
    assert.deepEqual(await capability.json(), { status: 'active', bootClassification: 'recovery-required' });
    assert.equal((await w.raw('outcome', { operationId: op(1), recover: true })).status, 400);
    const resolver = R.createSettlementEvidenceResolver({ householdId, acquire: () => w.syntheticAcquire(w.contextReader) });
    let privateOnly;
    // Public-object shape control only. All recovery behavior tests use the
    // actual HTTP-created instance's separately captured capability.
    const publicController = require('../scripts/settlement-evidence-confirmation').createSettlementEvidenceConfirmation({
      householdId, authorize: w.dependency.authorize, resolveSelection: resolver.resolveSelection,
      resolvePairedSelection: resolver.resolvePairedSelection, commitAdmitted: w.dependency.commitAdmitted,
      store: w.store, now: Date.now, registerRecovery: value => { privateOnly = value; } });
    assert.deepEqual(Object.keys(publicController).sort(), ['confirm', 'outcome', 'prepare']);
    assert.equal(Object.values(publicController).includes(privateOnly), false);
    assert.deepEqual(await a.capability(), { status: 'idle' }); assert.equal(a.inspections.length, 0);
    assert.equal(w.calls.commit, 0); assert.equal(a.registrations(), 1);
  });
  test('HTTP recovery registration resolves actual committed postauthorization uncertainty with fresh exact inspection', async t => {
    const a = await capturedHttpWorld(t), { w } = a, p = await committedHttpUncertainty(w);
    const original = JSON.parse(w.durable.doc).operations[0], before = Buffer.from(w.durable.doc), pin = JSON.stringify(w.durable.pin);
    w.authorized = true; w.cell.revision++;
    const next = await nextHttpRequest(w);
    assert.deepEqual(await w.post('prepare', next), { status: 'unavailable', reason: 'outcome-unresolved' });
    w.authorized = false; w.cell.revision++;
    assert.deepEqual(await a.capability(), { status: 'resolved' });
    assert.equal(a.inspections.length, 1); const inspected = a.inspections[0];
    assert.deepEqual(inspected.result, { disposition: 'committed', ready: true });
    assert.equal(inspected.input.actorId === original.actorId && inspected.input.preview.operationId === p.operationId, true);
    assert.equal(inspected.input.confirmationDigest === original.requestDigest, true);
    assert.equal((await w.raw('outcome', { operationId: p.operationId })).status, 503, 'private recovery grants no HTTP authority');
    w.authorized = true; w.cell.revision++;
    const receipt = await w.post('outcome', { operationId: p.operationId }); assert.equal(receipt.status, 'committed');
    const owner = w.cookie; w.cookie = await w.login();
    assert.equal((await w.post('outcome', { operationId: p.operationId })).status, 'unknown'); w.cookie = owner;
    assert.equal(require('node:util').isDeepStrictEqual(await w.post('outcome', { operationId: p.operationId }), receipt), true);
    assert.equal((await w.post('prepare', next)).status, 'prepared');
    assert.deepEqual(await a.capability(), { status: 'idle' }); assert.equal(a.inspections.length, 1);
    assert.equal(w.calls.commit, 1); assert.equal(w.calls.journal, 1); assert.equal(a.reconciliations(), 0);
    assert.ok(w.durable.doc.equals(before)); assert.equal(JSON.stringify(w.durable.pin), pin);
  });
  test('HTTP recovery registration keeps lost journal acknowledgement blocked until explicit test-owned reconciliation', async t => {
    const a = await capturedHttpWorld(t), { w } = a, p = await w.prepare();
    w.hooks.journalWrite = async () => { throw new Error('synthetic lost journal acknowledgement'); };
    assert.equal((await correlatedConfirm(w, p)).status, 'unknown'); delete w.hooks.journalWrite;
    const before = Buffer.from(w.durable.doc), pin = JSON.stringify(w.durable.pin), journal = Buffer.from(w.durable.journal);
    assert.deepEqual(await a.capability(), { status: 'blocked' });
    assert.deepEqual(a.inspections[0].result, { disposition: 'not-committed', ready: false });
    assert.deepEqual(await a.capability(), { status: 'blocked' }); assert.equal(a.inspections.length, 2);
    assert.ok(w.durable.doc.equals(before)); assert.ok(w.durable.journal.equals(journal));
    assert.equal(JSON.stringify(w.durable.pin), pin); assert.equal(a.reconciliations(), 0);
    // Explicit TEST-OWNED mutation, authorized only in this synthetic fixture.
    // Reconcile can mutate before returning; its report is never permission.
    await w.store.reconcile();
    assert.equal(w.durable.journal, null); assert.equal(a.reconciliations(), 1);
    assert.deepEqual(await a.capability(), { status: 'resolved' }); assert.equal(a.inspections.length, 3);
    assert.deepEqual(a.inspections[2].result, { disposition: 'not-committed', ready: true });
    assert.equal((await w.post('outcome', { operationId: p.operationId })).status, 'unknown', 'no durable browser negative proof is added');
    assert.equal((await w.post('prepare', { operationId: op(2), selection: await w.selection(), assignedCents: 2500 })).status, 'prepared');
    assert.equal(w.calls.commit, 1); assert.equal(w.calls.journal, 1); assert.ok(w.durable.doc.equals(before));
  });
  test('HTTP recovery registration requires readiness even for a committed ledger receipt', async t => {
    const a = await capturedHttpWorld(t), { w } = a;
    w.hooks.journalClear = async () => { throw new Error('synthetic journal cleanup refusal'); };
    await committedHttpUncertainty(w); delete w.hooks.journalClear;
    const before = Buffer.from(w.durable.doc), journal = Buffer.from(w.durable.journal);
    assert.deepEqual(await a.capability(), { status: 'blocked' });
    assert.deepEqual(a.inspections[0].result, { disposition: 'committed', ready: false });
    assert.ok(w.durable.doc.equals(before)); assert.ok(w.durable.journal.equals(journal)); assert.equal(a.reconciliations(), 0);
    await w.store.reconcile(); // Explicit TEST-OWNED reconciliation, never automatic.
    assert.deepEqual(await a.capability(), { status: 'resolved' });
    assert.deepEqual(a.inspections[1].result, { disposition: 'committed', ready: true });
    assert.equal(w.calls.commit, 1); assert.equal(w.calls.journal, 1); assert.equal(a.reconciliations(), 1);
  });
  test('HTTP recovery registration refuses unreadable divergent and same-ID inspection traces without mutation', async t => {
    for (const mode of ['unreadable', 'divergent', 'same-ID']) {
      const a = await capturedHttpWorld(t), { w } = a;
      if (mode === 'same-ID') {
        const p = await w.prepare(), prepare = w.store.prepare; let incoming;
        w.store.prepare = async input => { incoming = input; return prepare(input); };
        w.hooks.admission = async () => { throw new Error('synthetic ambiguous admission transport'); };
        assert.equal((await correlatedConfirm(w, p)).status, 'unknown'); delete w.hooks.admission;
        await appendCompetingRecord(w, incoming, { sameId: true }, prepare);
      } else await committedHttpUncertainty(w);
      if (mode === 'unreadable') w.hooks.storageRead = async name => { if (name === 'pin') throw new Error('synthetic unreadable pin'); };
      if (mode === 'divergent') w.durable.pin = { ...w.durable.pin, digest: 'f'.repeat(64) };
      const before = Buffer.from(w.durable.doc), pin = JSON.stringify(w.durable.pin);
      assert.deepEqual(await a.capability(), { status: 'blocked' });
      assert.equal(a.inspections[0].result.disposition, 'unresolved');
      assert.ok(w.durable.doc.equals(before)); assert.equal(JSON.stringify(w.durable.pin), pin);
      assert.equal(w.calls.commit, 1); assert.equal(a.reconciliations(), 0);
    }
  });
  test('HTTP recovery registration blocks during actual commit and postauthorization invocations', async t => {
    for (const phase of ['commit', 'postauthorization']) {
      const a = await capturedHttpWorld(t), { w } = a, p = await w.prepare();
      const seen = registrationGate(), gate = registrationGate(); let held = false;
      if (phase === 'commit') w.hooks.admission = async () => { seen.resolve(); await gate.promise; };
      w.hooks.authorize = async () => {
        if (!held && w.calls.commit && JSON.parse(w.durable.doc).operations.length) {
          held = true; if (phase === 'postauthorization') { seen.resolve(); await gate.promise; }
          w.authorized = false;
        }
      };
      const pending = w.raw('confirm', { operationId: p.operationId, previewToken: p.previewToken,
        generation: p.generation, confirmed: true });
      await seen.promise;
      try {
        assert.deepEqual(await a.capability(), { status: 'blocked' }); assert.equal(a.inspections.length, 0);
        gate.resolve(); assert.equal((await pending).status, 503);
        assert.deepEqual(await a.capability(), { status: 'resolved' }); assert.equal(a.inspections.length, 1);
        assert.equal(w.calls.commit, 1); assert.equal(w.calls.journal, 1); assert.equal(a.reconciliations(), 0);
      } finally { gate.resolve(); }
    }
  });
  test('HTTP recovery registration rejects an obsolete delayed inspection before inspecting a newer latch', async t => {
    const a = await capturedHttpWorld(t), { w } = a, original = await committedHttpUncertainty(w);
    w.authorized = true; w.cell.revision++;
    const inspect = w.store.inspectAttempt, seen = registrationGate(), gate = registrationGate(); let hold = true;
    w.store.inspectAttempt = async input => {
      const result = await inspect(input);
      if (hold) { hold = false; seen.resolve(); await gate.promise; }
      return result;
    };
    const delayed = a.capability(); await seen.promise;
    try {
      assert.equal((await w.post('outcome', { operationId: original.operationId })).status, 'committed');
      const nextRequest = await nextHttpRequest(w), next = await w.post('prepare', nextRequest);
      w.hooks.admission = async () => { throw new Error('synthetic newer ambiguous attempt'); };
      assert.equal((await correlatedConfirm(w, next)).status, 'unknown'); delete w.hooks.admission;
      gate.resolve(); assert.deepEqual(await delayed, { status: 'obsolete' });
      assert.deepEqual(await w.post('prepare', { ...nextRequest, operationId: op(3) }), { status: 'unavailable', reason: 'outcome-unresolved' });
      assert.deepEqual(await a.capability(), { status: 'resolved' }); assert.equal(a.inspections.length, 2);
      assert.equal(a.inspections[0].input.preview.operationId === original.operationId, true);
      assert.equal(a.inspections[1].input.preview.operationId === next.operationId, true);
      assert.equal((await w.post('outcome', { operationId: next.operationId })).status, 'unknown');
      assert.equal(w.calls.commit, 2); assert.equal(w.calls.journal, 1); assert.equal(a.reconciliations(), 0);
    } finally { gate.resolve(); }
  });
  test('HTTP recovery registration keeps separate application capabilities and uncertainty isolated', async t => {
    const a = await capturedHttpWorld(t), b = await capturedHttpWorld(t);
    assert.notEqual(a.capability, b.capability); await committedHttpUncertainty(a.w);
    assert.deepEqual(await b.capability(), { status: 'idle' }); assert.equal(b.inspections.length, 0);
    assert.deepEqual(await a.capability(), { status: 'resolved' });
    const p = await b.w.prepare(); b.w.hooks.admission = async () => { throw new Error('synthetic isolated unknown'); };
    assert.equal((await correlatedConfirm(b.w, p)).status, 'unknown'); delete b.w.hooks.admission;
    assert.deepEqual(await a.capability(), { status: 'idle' });
    assert.deepEqual(await b.w.post('prepare', { operationId: op(2), selection: await b.w.selection(), assignedCents: 2500 }),
      { status: 'unavailable', reason: 'outcome-unresolved' });
    assert.deepEqual(await b.capability(), { status: 'resolved' });
    assert.equal(a.w.calls.commit, 1); assert.equal(b.w.calls.commit, 1); assert.equal(b.w.calls.journal, 0);
  });
  test('probe mismatch real link prepares return exact terminal proof without refused-operation writes', async t => {
    const w = await startWorld(); t.after(w.close);
    const p = await w.prepare(), control = armProbeCompetition(w, p.operationId);
    const result = await correlatedConfirm(w, p);
    console.log(JSON.stringify({ synthetic: true, stage: 'successful-probe-mismatch', status: result.status, reason: result.reason,
      successfulProbe: control.successfulProbe, refusedCommitInvocations: w.calls.commit,
      journalWrites: w.calls.journal, competingStateUnchanged: w.durable.doc.equals(control.competing.doc) }));
    assert.equal(control.successfulProbe, true);
    assert.equal(require('node:util').isDeepStrictEqual(result, negative(p)), true, 'exact operation/token/generation proof');
    assert.equal(w.calls.commit, 0); assert.equal(w.calls.journal, 1);
    assert.ok(w.durable.doc.equals(control.competing.doc)); assert.equal(JSON.stringify(w.durable.pin), control.competing.pin);
    assert.equal((await w.post('outcome', { operationId: p.operationId })).status, 'unknown', 'negative proof is not durable absence recovery');
  });
  for (const phase of ['early', 'probe']) {
    test('probe mismatch withdrawal ' + phase + ' window uses exact terminal proof without retracting', async t => {
      const w = await startWorld(); t.after(w.close); await w.confirm(await w.prepare());
      const p = await withdrawal(w); let state, control;
      if (phase === 'early') {
        const first = JSON.parse(w.durable.doc).operations[0];
        state = await appendCompetingRecord(w, { operationId: p.operationId, command: first.command });
      } else control = armProbeCompetition(w, p.operationId);
      const result = await correlatedConfirm(w, p); state ||= control.competing;
      assert.equal(require('node:util').isDeepStrictEqual(result, negative(p)), true, 'exact generation proof');
      if (control) assert.equal(control.successfulProbe, true, 'change landed after qualified target acquisition');
      assert.equal(w.calls.commit, 1, 'only the original assignment used the controller commit capability');
      assert.equal(w.calls.journal, 2); assert.ok(w.durable.doc.equals(state.doc));
      assert.ok(JSON.parse(w.durable.doc).operations.every(o => o.command.kind === 'link'), 'no withdrawal was recorded');
    });
  }
  for (const phase of ['probe', 'post-store']) for (const journal of [false, true]) {
    test('probe safety ' + phase + ' same-ID ' + (journal ? 'journal' : 'ledger') + ' is never negative proof', async t => {
      const w = await startWorld(); t.after(w.close); const p = await w.prepare(); let control;
      if (phase === 'probe') control = armProbeCompetition(w, p.operationId, { sameId: true, journal });
      else {
        control = {}; const prepare = w.store.prepare; let incoming;
        w.store.prepare = async input => { incoming = input; return prepare(input); };
        w.hooks.admission = async () => {
          control.competing = await appendCompetingRecord(w, incoming, { sameId: true, journal }, prepare);
        };
      }
      const result = await correlatedConfirm(w, p), state = control.competing;
      assert.notEqual(result.status, 'not-applied'); assert.notEqual(result.status, 'committed');
      if (phase === 'probe') assert.equal(control.successfulProbe, false, 'unsafe trace cannot yield a valid fresh preview');
      else assert.equal(result.reason, 'store-conflict', 'same-ID actor/digest conflict remains generic even with a resident journal');
      assert.equal(w.calls.commit, phase === 'probe' ? 0 : 1);
      assert.equal(w.calls.journal, 1); assert.ok(w.durable.doc.equals(state.doc));
      assert.equal(JSON.stringify(w.durable.pin), state.pin);
      if (journal) assert.ok(w.durable.journal.equals(state.journal), 'resident journal was not reconciled');
      assert.notEqual((await w.post('outcome', { operationId: p.operationId })).status, 'committed', 'another actor receipt is private');
    });
  }
  test('probe safety post-store distinct-ID journal remains recovery-required without proof or repair', async t => {
    const w = await startWorld(); t.after(w.close); const p = await w.prepare();
    const prepare = w.store.prepare; let incoming, competing;
    w.store.prepare = async input => { incoming = input; return prepare(input); };
    w.hooks.admission = async () => { competing = await appendCompetingRecord(w, incoming, { journal: true }, prepare); };
    const result = await correlatedConfirm(w, p);
    assert.deepEqual(result, { status: 'rejected', reason: 'recovery-required' });
    assert.equal(w.calls.commit, 1); assert.equal(w.calls.journal, 1);
    assert.ok(w.durable.doc.equals(competing.doc)); assert.ok(w.durable.journal.equals(competing.journal));
    assert.equal(JSON.stringify(w.durable.pin), competing.pin);
  });
  test('probe mismatch legacy and wrong actor cannot obtain terminal proof or consume another preview', async t => {
    for (const legacy of [true, false]) {
      const w = await startWorld(); t.after(w.close); const p = await w.prepare();
      const control = armProbeCompetition(w, p.operationId);
      if (legacy) {
        assert.notEqual((await w.confirm(p)).status, 'not-applied');
        assert.equal(control.successfulProbe, true); assert.equal(w.calls.commit, 0);
      } else {
        const owner = w.cookie; w.cookie = await w.login();
        assert.equal((await correlatedConfirm(w, p)).status, 'unknown');
        assert.equal(control.probeEntered, false); w.cookie = owner;
        assert.equal((await correlatedConfirm(w, p)).status, 'not-applied');
      }
      assert.equal(w.calls.journal, 1);
    }
  });
  test('probe mismatch transport postauthorization suppresses a retired negative acknowledgement', async t => {
    const w = await startWorld(); t.after(w.close); const p = await w.prepare(), control = armProbeCompetition(w, p.operationId);
    let postProbe = 0;
    w.hooks.authorize = async () => { if (control.successfulProbe && ++postProbe === 2) w.authorized = false; };
    const response = await w.raw('confirm', { operationId: p.operationId, previewToken: p.previewToken,
      generation: p.generation, confirmed: true });
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { status: 'unavailable' });
    assert.equal(postProbe, 2); assert.equal(w.calls.commit, 0); assert.equal(w.calls.journal, 1);
  });
  const ordinary = (w, cookie = w.cookie) => fetch(w.origin + '/data.json', { headers: { Cookie: cookie } });
  const costFacts = data => {
    const row = Forecast.savingsInventory(data.plan, data.meta.asOf,
      { settlementEvidence: data.settlementEvidence }).pools[0].plannedGoals[0];
    return { original: row.target, paid: row.linkedPaid, remaining: row.remaining };
  };
  test('raw constructor ordinary browser reads retain assignment withdrawal and separate relink', async t => {
    const w = await startWorld(); t.after(w.close);
    assert.equal(w.base.settlementEvidenceStatus, undefined, 'fixture base is raw');
    const p = await w.prepare(), receipt = await w.confirm(p);
    assert.equal((await w.post('publication', { operationId: p.operationId })).publication, 'included');
    let response = await ordinary(w); assert.equal(response.status, 200);
    let data = await response.json();
    assert.equal(data.settlementEvidenceStatus?.status, 'qualified');
    assert.deepEqual(costFacts(data), { original: 60, paid: 25, remaining: 35 }); assert.equal(w.calls.commit, 1);
    assert.equal((await ordinary(w)).headers.get('cache-control'), 'no-store, max-age=0', 'incumbent browser cache policy is preserved');
    assert.equal((await w.confirm(await withdrawal(w))).status, 'committed');
    data = await (await ordinary(w)).json();
    assert.deepEqual(costFacts(data), { original: 60, paid: 0, remaining: 60 }); assert.equal(w.calls.commit, 2);
    assert.equal((await w.confirm(await w.prepare(12))).status, 'committed');
    data = await (await ordinary(w)).json();
    assert.deepEqual(costFacts(data), { original: 60, paid: 25, remaining: 35 }); assert.equal(w.calls.commit, 3);
    assert.deepEqual(await w.post('outcome', { operationId: p.operationId }), receipt);
    assert.deepEqual(JSON.parse(w.durable.doc).operations.map(o => o.command.kind), ['link', 'retract', 'link']);
  });
  test('ordinary browser reader failure withholds stale evidence and recovers without writing', async t => {
    const w = await startWorld(); t.after(w.close); await w.confirm(await w.prepare());
    const before = Buffer.from(w.durable.doc), pin = JSON.stringify(w.durable.pin);
    w.base.settlementEvidence = { hostile: true }; w.base.settlementEvidenceStatus = { status: 'qualified' };
    w.readFailure = true;
    const response = await ordinary(w); assert.equal(response.status, 200);
    const unavailable = await response.json();
    assert.equal(unavailable.settlementEvidenceStatus.status, 'unavailable');
    assert.equal(unavailable.settlementEvidence, undefined); assert.ok(!JSON.stringify(unavailable).includes('SYNTHETIC-PRIVATE'));
    w.readFailure = false;
    const recovered = await (await ordinary(w)).json(); assert.equal(recovered.settlementEvidenceStatus.status, 'qualified');
    assert.deepEqual(costFacts(recovered), { original: 60, paid: 25, remaining: 35 });
    const label = w.base.plan.commitments[0].label;
    w.hooks.document = async () => { w.base.plan.commitments[0].label = 'Changed during storage acquisition'; };
    assert.equal((await (await ordinary(w)).json()).plan.commitments[0].label, label, 'complete base owned before storage awaits');
    assert.ok(w.durable.doc.equals(before)); assert.equal(JSON.stringify(w.durable.pin), pin); assert.equal(w.calls.commit, 1);
  });
  test('ordinary browser policy authorizes before base/storage acquisition and rechecks after read', async t => {
    const w = await startWorld(); t.after(w.close); await w.confirm(await w.prepare());
    let bases = 0; w.hooks.rawBase = async () => { bases++; };
    const reads = w.calls.storage; w.authorized = false;
    let response = await ordinary(w); assert.equal(response.status, 503);
    assert.equal(bases, 0); assert.equal(w.calls.storage, reads); assert.deepEqual(await response.json(), { error: 'data unavailable' });
    w.authorized = true; w.hooks.document = async () => { w.authorized = false; };
    response = await ordinary(w); assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'data unavailable' }); assert.equal(w.calls.commit, 1);
    w.authorized = true; delete w.hooks.document;
    w.hooks.rawBase = async () => { w.authorized = false; };
    const beforeStorage = w.calls.storage;
    response = await ordinary(w); assert.equal(response.status, 503);
    assert.equal(w.calls.storage, beforeStorage, 'revocation during base read prevents settlement acquisition');
  });
  test('ordinary browser rejects legacy/tampered/expired authority and expiry during acquisition', async t => {
    const w = await startWorld(); t.after(w.close); await w.confirm(await w.prepare());
    const signed = payload => { const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return 'hfd_session=' + b + '.' + crypto.createHmac('sha256', env.SESSION_SECRET).update(b).digest('base64url'); };
    const reads = w.calls.storage;
    for (const cookie of ['', w.cookie + 'tampered', signed({ exp: Date.now() + 60000 }),
      signed({ exp: Date.now() - 1, sid: '1'.repeat(64) })]) assert.equal((await ordinary(w, cookie)).status, 401);
    assert.equal(w.calls.storage, reads);
    const actualNow = Date.now, expiresAt = actualNow() + 60000; t.after(() => { Date.now = actualNow; });
    w.hooks.document = async () => { Date.now = () => expiresAt + 1; };
    const response = await ordinary(w, signed({ exp: expiresAt, sid: '1'.repeat(64) }));
    assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: 'not authenticated' });
  });
  test('ordinary browser household projection is cross-login but private receipt remains actor-bound', async t => {
    const w = await startWorld(); t.after(w.close); const p = await w.prepare(), receipt = await w.confirm(p);
    const originalActor = JSON.parse(w.durable.doc).operations[0].actorId; w.cookie = await w.login();
    const data = await (await ordinary(w)).json(); assert.equal(data.settlementEvidenceStatus?.status, 'qualified');
    assert.deepEqual(costFacts(data), { original: 60, paid: 25, remaining: 35 });
    assert.ok(!JSON.stringify(data).includes(originalActor)); assert.ok(!JSON.stringify(data).includes(receipt.digest));
    assert.equal(data.receipt, undefined); assert.equal((await w.post('outcome', { operationId: p.operationId })).status, 'unknown');
    assert.equal(w.calls.commit, 1);
  });
  test('ordinary browser compositions isolate two active reader sets and an inactive application', async t => {
    const a = await startWorld(), b = await startWorld(), inactive = await startWorld(false);
    t.after(async () => { await a.close(); await b.close(); await inactive.close(); });
    await a.confirm(await a.prepare());
    assert.deepEqual(costFacts(await (await ordinary(a)).json()), { original: 60, paid: 25, remaining: 35 });
    const reads = a.calls.storage;
    assert.deepEqual(costFacts(await (await ordinary(b)).json()), { original: 60, paid: 0, remaining: 60 });
    assert.equal(a.calls.storage, reads); assert.equal(b.calls.commit, 0);
    assert.deepEqual(await (await ordinary(inactive)).json(), inactive.base); assert.equal(inactive.calls.storage, 0);
  });
  test('ordinary browser opt-in leaves assistant MCP off settlement readers', async t => {
    const bearer = syntheticCredential('assistant'); const w = await startWorld(true, { env: { ATLAS_ASSISTANT_TOKEN: bearer } }); t.after(w.close);
    const receipt = await w.confirm(await w.prepare()); const reads = w.calls.storage;
    const assistant = await fetch(w.origin + '/assistant/current', { headers: { Authorization: 'Bearer ' + bearer } });
    assert.equal(assistant.status, 200); assert.ok(!JSON.stringify(await assistant.json()).includes(receipt.digest));
    const mcp = await fetch(w.origin + '/assistant/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: w.cookie },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) });
    assert.ok([401, 503].includes(mcp.status)); assert.equal(w.calls.storage, reads, 'only browser data may opt into these readers');
    assert.equal(w.calls.commit, 1);
  });
  test('terminal proof: real store expiry after final controller check is prejournal no-effect', async t => {
    let clock = Date.now(); const w = await startWorld(true, { now: () => clock }); t.after(w.close);
    const p = await w.prepare(); clock = p.expiresAt - 1;
    const before = Buffer.from(w.durable.doc), pin = JSON.stringify(w.durable.pin);
    w.hooks.admission = async () => { clock = p.expiresAt; };
    const ack = await correlatedConfirm(w, p);
    assert.equal(w.calls.commit, 1); assert.equal(w.calls.journal, 0);
    assert.ok(w.durable.doc.equals(before)); assert.equal(JSON.stringify(w.durable.pin), pin);
    console.log(JSON.stringify({ type: 'store-expiry-boundary', status: ack.status, reason: ack.reason,
      commitInvocations: w.calls.commit, journalWrites: w.calls.journal, durableBytesUnchanged: true }));
    assert.equal(ack.status, 'not-applied');
    assert.equal(require('node:util').isDeepStrictEqual(ack, negative(p)), true, 'exact generation-bound negative acknowledgement');
    assert.equal((await w.prepare()).status, 'unavailable', 'terminal operation is not recycled in this controller');
  });
  test('terminal proof: real store expiry still requires transport postauthorization', async t => {
    let clock = Date.now(); const w = await startWorld(true, { now: () => clock }); t.after(w.close);
    const p = await w.prepare(); clock = p.expiresAt - 1;
    const before = Buffer.from(w.durable.doc);
    w.hooks.admission = async () => { clock = p.expiresAt; };
    let calls = 0; w.hooks.authorize = async () => { if (++calls === 7) w.authorized = false; };
    const r = await w.raw('confirm', { operationId: p.operationId, previewToken: p.previewToken,
      generation: p.generation, confirmed: true });
    assert.equal(r.status, 503); assert.deepEqual(await r.json(), { status: 'unavailable' });
    assert.equal(calls, 7); assert.equal(w.calls.commit, 1); assert.equal(w.calls.journal, 0);
    assert.ok(w.durable.doc.equals(before));
  });
  test('terminal proof: expiry binds exact generation; same-ID reuse refuses until controller restart', async t => {
    let clock = Date.now(); const w = await startWorld(true, { now: () => clock }); t.after(w.close);
    const p = await w.prepare(); assert.match(p.generation, /^generation-[a-f0-9]{32}$/);
    clock += require('../scripts/planned-obligation-settlement-contract').TTL_MS;
    assert.deepEqual(await correlatedConfirm(w, p), negative(p));
    assert.equal((await w.prepare()).status, 'unavailable', 'retired correlation is not recycled in this controller');
    assert.equal(w.calls.commit, 0); assert.equal(w.calls.journal, 0);
    w.recreate(); const next = await w.prepare();
    assert.equal(next.status, 'prepared'); assert.notEqual(next.generation, p.generation);
    assert.notEqual(next.previewToken, p.previewToken);
    assert.notEqual((await correlatedConfirm(w, p)).status, 'not-applied', 'old generation has no negative authority over replacement');
    assert.equal((await correlatedConfirm(w, next)).status, 'committed');
    assert.equal(w.calls.commit, 1);
    const durable = w.durable.doc.toString('utf8');
    assert.equal(durable.includes(next.generation), false, 'correlation never enters ledger/receipt');
    assert.equal(durable.includes(next.previewToken), false, 'preview token remains transient');
  });
  test('terminal proof: selection drift and actual prejournal admission refusal; errors are not proof', async t => {
    const w = await startWorld(); t.after(w.close);
    let p = await w.prepare(1); w.acquisition.packet.observationAsOf = '2026-10-06';
    assert.deepEqual(await correlatedConfirm(w, p), negative(p));
    assert.equal(w.calls.commit, 0);
    p = await w.prepare(2); w.hooks.admission = async () => { w.cell.revision++; };
    assert.deepEqual(await correlatedConfirm(w, p), negative(p));
    assert.equal(w.calls.journal, 0);
    delete w.hooks.admission; p = await w.prepare(3);
    for (const generation of [null, {}, 'invalid']) {
      assert.equal((await w.raw('confirm', { operationId: p.operationId, previewToken: p.previewToken,
        generation, confirmed: true })).status, 400);
    }
    assert.equal((await correlatedConfirm(w, p, { generation: 'generation-' + 'f'.repeat(32) })).status, 'rejected');
    assert.equal((await correlatedConfirm(w, p, { previewToken: 'f'.repeat(64) })).status, 'rejected');
    assert.equal((await correlatedConfirm(w, p)).status, 'committed');
  });
  test('terminal proof: authorization revoked after controller result suppresses HTTP acknowledgement', async t => {
    let clock = Date.now(); const w = await startWorld(true, { now: () => clock }); t.after(w.close);
    const p = await w.prepare(); clock += require('../scripts/planned-obligation-settlement-contract').TTL_MS;
    let calls = 0;
    w.hooks.authorize = async () => { if (++calls === 5) w.authorized = false; };
    // Route preauth, controller authority/outcome reauth/terminal reauth,
    // then transport postauth. Revoke that final authorization only.
    const r = await w.raw('confirm', { operationId: p.operationId, previewToken: p.previewToken,
      generation: p.generation, confirmed: true });
    assert.equal(r.status, 503); assert.deepEqual(await r.json(), { status: 'unavailable' });
    assert.equal(w.calls.commit, 0); assert.equal(w.calls.journal, 0);
});
  test('withdrawal cross-login creates its own receipt; absent provider/goal and historical receipts survive', async t => {
    const w = await startWorld(); t.after(w.close);
    const p = await w.prepare(); const original = await w.confirm(p); const firstCookie = w.cookie;
    w.cookie = await w.login();
    w.acquisition.packet.transactions = []; w.base.plan.commitments = [];
    const c = await w.post('assignments', {}); assert.equal(c.status, 'available');
    assert.equal(c.assignments.length, 1);
    assert.deepEqual(Object.keys(c.assignments[0]).sort(), ['assignedCents', 'currency', 'date', 'handle', 'label', 'reversals']);
    assert.ok(!JSON.stringify(c).includes(original.digest));
    assert.equal((await w.post('outcome', { operationId: p.operationId })).status, 'unknown');
    const u = await w.post('prepare-withdrawal', { operationId: op(10), assignmentHandle: c.assignments[0].handle });
    assert.equal(u.status, 'prepared'); assert.equal(w.calls.commit, 1, 'preview read-only');
    const own = await w.confirm(u); assert.equal(own.status, 'committed');
    assert.equal(w.calls.commit, 2);
    assert.deepEqual(await w.confirm(u), own, 'repeat confirm original withdrawal receipt');
    assert.equal(w.calls.commit, 2);
    const view = await w.post('publication', { operationId: u.operationId });
    assert.equal(view.publication, 'included'); assert.deepEqual(view.data.settlementEvidence.commitments, []);
    const doc = JSON.parse(w.durable.doc); assert.equal(doc.operations[1].command.kind, 'retract');
    assert.notEqual(doc.operations[1].actorId, doc.operations[0].actorId);
    w.recreate(); assert.deepEqual(await w.post('outcome', { operationId: u.operationId }), own);
    w.cookie = firstCookie;
    assert.deepEqual(await w.post('outcome', { operationId: p.operationId }), original);
    assert.equal((await w.post('publication', { operationId: p.operationId })).publication, 'included');
    assert.equal((await w.post('outcome', { operationId: u.operationId })).status, 'unknown');
  });
  test('withdrawal conserves independent 60/25/10/20 arithmetic and separate normal relink', async t => {
    const w = await startWorld(); t.after(w.close);
    const p = await w.prepare(); await w.confirm(p);
    const first = JSON.parse(w.durable.doc).operations[0];
    const C = require('../scripts/planned-obligation-settlement-contract');
    const counter = { ...first.command.evidence, direction: 'credit', cents: 1000 };
    await syntheticRecord(w, 2, { version: 1, kind: 'reverse', targetOperationId: p.operationId,
      counterTxRef: 'tx-' + '9'.repeat(32), counterEvidence: counter, counterEvidenceDigest: C.digest(counter), cents: 1000 }, first.actorId);
    await syntheticRecord(w, 3, { ...first.command, goalId: 'commitment:synthetic-sibling', assignedCents: 2000 }, first.actorId);
    const u = await withdrawal(w); await w.confirm(u);
    assert.equal(JSON.parse(w.durable.doc).operations.length, 4, 'withdrawal alone never relinks');
    const selection = await w.selection();
    assert.notEqual((await w.post('prepare', { operationId: op(11), selection, assignedCents: 3001 })).status, 'prepared');
    const relink = await w.post('prepare', { operationId: op(12), selection, assignedCents: 3000 });
    assert.equal(relink.status, 'prepared'); await w.confirm(relink);
    assert.notEqual((await w.post('prepare', { operationId: op(13), selection, assignedCents: 1 })).status, 'prepared');
    assert.equal(JSON.parse(w.durable.doc).operations.length, 5);
  });
  test('withdrawal stale catalogue and preview, context ABA and late domain fence refuse without writes', async t => {
    const w = await startWorld(); t.after(w.close); await w.confirm(await w.prepare());
    const c = await w.post('assignments', {}); const handle = c.assignments[0].handle;
    const cookie = w.cookie; w.cookie = await w.login();
    assert.notEqual((await w.post('prepare-withdrawal', { operationId: op(10), assignmentHandle: handle })).status, 'prepared');
    w.cookie = cookie;
    let u = await w.post('prepare-withdrawal', { operationId: op(10), assignmentHandle: handle });
    w.cell.revision += 2; // revoke/restore or A-B-A must advance monotonically.
    assert.equal((await w.confirm(u)).status, 'rejected'); assert.equal(w.calls.commit, 1);
    u = await withdrawal(w, 11);
    w.hooks.admission = async () => { w.cell.domain = 'changed-domain'; w.cell.revision++; };
    assert.equal((await w.confirm(u)).status, 'rejected'); assert.equal(w.calls.journal, 1);
    delete w.hooks.admission;
    u = await withdrawal(w, 12);
    const first = JSON.parse(w.durable.doc).operations[0];
    await syntheticRecord(w, 20, { ...first.command, goalId: 'commitment:sibling', assignedCents: 1 }, first.actorId);
    assert.notEqual((await w.confirm(u)).status, 'committed'); assert.equal(w.calls.journal, 2, 'only the explicit synthetic sibling appended');
    assert.notEqual((await w.post('prepare-withdrawal', { operationId: op(21), assignmentHandle: handle })).status, 'prepared');
  });
  test('withdrawal full reversal preserves consumed capacity, sibling and original receipt', async t => {
    const w = await startWorld(); t.after(w.close);
    const p = await w.prepare(); const receipt = await w.confirm(p);
    const first = JSON.parse(w.durable.doc).operations[0], C = require('../scripts/planned-obligation-settlement-contract');
    const evidence = { ...first.command.evidence, direction: 'credit', cents: 2500 };
    await syntheticRecord(w, 2, { version: 1, kind: 'reverse', targetOperationId: p.operationId,
      counterTxRef: 'tx-' + '8'.repeat(32), counterEvidence: evidence, counterEvidenceDigest: C.digest(evidence), cents: 2500 }, first.actorId);
    await syntheticRecord(w, 3, { ...first.command, goalId: 'commitment:sibling', assignedCents: 2000 }, first.actorId);
    const u = await withdrawal(w); assert.equal((await w.confirm(u)).status, 'committed');
    const selection = await w.selection();
    assert.notEqual((await w.post('prepare', { operationId: op(11), selection, assignedCents: 1501 })).status, 'prepared');
    const next = await w.post('prepare', { operationId: op(12), selection, assignedCents: 1500 });
    assert.equal(next.status, 'prepared'); assert.equal((await w.confirm(next)).status, 'committed');
    assert.deepEqual(await w.post('outcome', { operationId: p.operationId }), receipt);
    const doc = JSON.parse(w.durable.doc); assert.equal(doc.operations[1].command.kind, 'reverse');
    assert.equal(doc.operations[2].command.assignedCents, 2000); assert.equal(doc.operations.length, 5);
  });
  test('withdrawal handles expire, strict bodies reject authority and post-acquisition revocation withholds catalogue', async t => {
    let clock = Date.now(); const w = await startWorld(true, { now: () => clock }); t.after(w.close);
    await w.confirm(await w.prepare()); const c = await w.post('assignments', {});
    for (const field of ['actorId', 'householdId', 'targetOperationId', 'receipt', 'command', 'readers'])
      assert.equal((await w.raw('prepare-withdrawal', { operationId: op(10), assignmentHandle: c.assignments[0].handle, [field]: 'forged' })).status, 400);
    assert.equal((await w.raw('assignments', { actorId: 'forged' })).status, 400);
    clock += require('../scripts/planned-obligation-settlement-contract').TTL_MS;
    assert.notEqual((await w.post('prepare-withdrawal', { operationId: op(10), assignmentHandle: c.assignments[0].handle })).status, 'prepared');
    w.hooks.document = async () => { w.authorized = false; };
    const denied = await w.raw('assignments', {}); assert.equal(denied.status, 503);
    assert.deepEqual(await denied.json(), { status: 'unavailable' }); assert.equal(w.calls.commit, 1);
  });
  for (const change of ['expiry', 'replacement']) {
    test('prepared withdrawal survives discovery catalogue ' + change, async t => {
      const t0 = Date.now(); let clock = t0;
      const w = await startWorld(true, { now: () => clock }); t.after(w.close);
      await w.confirm(await w.prepare());
      const c = await w.post('assignments', {}), handle = c.assignments[0].handle;
      clock = t0 + 60000;
      const p = await w.post('prepare-withdrawal', { operationId: op(10), assignmentHandle: handle });
      assert.equal(p.status, 'prepared');
      if (change === 'expiry') clock = t0 + require('../scripts/planned-obligation-settlement-contract').TTL_MS + 1000;
      else assert.notEqual((await w.post('assignments', {})).assignments[0].handle, handle);
      assert.ok(clock < p.expiresAt, 'prepared preview is still valid');
      assert.notEqual((await w.post('prepare-withdrawal', { operationId: op(11), assignmentHandle: handle })).status,
        'prepared', 'expired/replaced discovery handle cannot admit another prepare');
      const ownerCookie = w.cookie; w.cookie = await w.login();
      assert.equal((await correlatedConfirm(w, p)).status, 'unknown', 'another authorized login cannot consume this preview');
      assert.equal(w.calls.commit, 1); w.cookie = ownerCookie;
      const before = Buffer.from(w.durable.doc);
      const result = await correlatedConfirm(w, p);
      if (result.status !== 'committed') {
        const outcome = await w.post('outcome', { operationId: p.operationId });
        console.log(JSON.stringify({ synthetic: true, discoveryChange: change, confirm: result.status,
          reason: result.reason, outcome: outcome.status, commitInvocations: w.calls.commit,
          journalWrites: w.calls.journal, durableUnchanged: w.durable.doc.equals(before) }));
      }
      assert.equal(result.status, 'committed'); assert.equal(result.operationId, p.operationId);
      assert.equal(w.calls.commit, 2); assert.equal(w.calls.journal, 2);
      assert.deepEqual(await correlatedConfirm(w, p), result, 'repeat returns original own receipt');
      assert.equal(w.calls.commit, 2);
      const view = await w.post('publication', { operationId: p.operationId }); assert.equal(view.publication, 'included');
    });
  }
  test('withdrawal expiry at controller and real-store boundaries retains exact generation terminal proof', async t => {
    for (const boundary of ['controller', 'store']) {
      let clock = Date.now(); const w = await startWorld(true, { now: () => clock }); t.after(w.close);
      const original = await w.confirm(await w.prepare()); const p = await withdrawal(w);
      const before = Buffer.from(w.durable.doc), pin = JSON.stringify(w.durable.pin);
      clock = p.expiresAt - (boundary === 'store' ? 1 : 0);
      if (boundary === 'store') w.hooks.admission = async () => { clock = p.expiresAt; };
      assert.deepEqual(await correlatedConfirm(w, p), negative(p));
      assert.equal(w.calls.commit, boundary === 'store' ? 2 : 1);
      assert.equal(w.calls.journal, 1); assert.ok(w.durable.doc.equals(before));
      assert.equal(JSON.stringify(w.durable.pin), pin);
      assert.deepEqual(await w.post('outcome', { operationId: original.operationId }), original);
      assert.equal((await w.post('prepare-withdrawal', { operationId: p.operationId,
        assignmentHandle: 'assignment-' + '0'.repeat(32) })).status, 'unavailable');
    }
  });
  test('concurrent withdrawal and link share one in-flight write and never silently rebase', async t => {
    const w = await startWorld(); t.after(w.close); await w.confirm(await w.prepare());
    const goals = await w.post('selections', {}); assert.ok(goals.commitments.length > 1);
    const u = await withdrawal(w); const selection = { transaction: goals.transactions[0].handle, commitment: goals.commitments[1].handle };
    const link = await w.post('prepare', { operationId: op(11), selection, assignedCents: 1 }); assert.equal(link.status, 'prepared');
    let reached, release; const entered = new Promise(r => { reached = r; }), gate = new Promise(r => { release = r; });
    w.hooks.admission = async () => { reached(); await gate; };
    try {
      const pending = w.confirm(u); await entered;
      assert.equal((await w.confirm(link)).status, 'unknown'); assert.equal(w.calls.commit, 2);
      release(); assert.equal((await pending).status, 'committed'); delete w.hooks.admission;
      assert.notEqual((await w.confirm(link)).status, 'committed', 'old preview cannot rebase after withdrawal');
      const fresh = await w.post('prepare', { operationId: op(12), selection, assignedCents: 1 });
      assert.equal(fresh.status, 'prepared'); assert.equal((await w.confirm(fresh)).status, 'committed');
      assert.equal(w.calls.commit, 3);
    } finally { release(); }
  });
  test('default actual application is inactive and touches zero settlement storage', async t => {
    const w = await startWorld(false); t.after(w.close);
    const response = await fetch(w.origin + '/settlement/capability', { headers: { Cookie: w.cookie } });
    assert.deepEqual(await response.json(), { status: 'inactive', bootClassification: 'recovery-required' });
    assert.equal((await w.raw('selections', {})).status, 503);
    assert.equal((await w.raw('assignments', {})).status, 503);
    const data = await fetch(w.origin + '/data.json', { headers: { Cookie: w.cookie } });
    assert.deepEqual(await data.json(), w.base);
    assert.deepEqual(w.calls, { storage: 0, journal: 0, commit: 0, acquire: 0, base: 0 });
  });
  test('default, active and disabled constructions never attest preactivation history', async t => {
    const headers = { 'X-Atlas-Settlement': 'same-origin', 'Sec-Fetch-Site': 'same-origin' };
    const w = await startWorld(false); t.after(w.close);
    for (const mode of ['disabled', 'active', 'disabled']) {
      w.recreate(mode);
      const response = await fetch(w.origin + '/settlement/capability', { headers: { Cookie: w.cookie, ...headers } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).bootClassification, 'recovery-required');
    }
    assert.equal(w.calls.storage, 0); assert.equal(w.calls.acquire, 0); assert.equal(w.calls.commit, 0);
  });
  test('sealed preactivation rejects every supplied settlement dependency and only attests authenticated same-origin reads', async t => {
    const w = await startWorld(false, { preactivationOnly: true }); t.after(w.close);
    for (const value of [undefined, null, false, {}, w.dependency]) {
      assert.throws(() => createPreactivationApplication({ env, settlement: value }), /sealed preactivation/);
    }
    for (const [key, value] of Object.entries(w.dependency)) {
      assert.throws(() => createPreactivationApplication({ env, [key]: value }), /sealed preactivation/);
    }
    const headers = { Cookie: w.cookie, 'X-Atlas-Settlement': 'same-origin', 'Sec-Fetch-Site': 'same-origin' };
    const response = await fetch(w.origin + '/settlement/capability', { headers });
    assert.deepEqual(await response.json(), { status: 'inactive', bootClassification: 'preactivation-only' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    for (const override of [{ 'X-Atlas-Settlement': '' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': '' }]) {
      const denied = await fetch(w.origin + '/settlement/capability', { headers: { ...headers, ...override } });
      assert.equal((await denied.json()).bootClassification, 'recovery-required');
    }
    assert.equal((await fetch(w.origin + '/settlement/capability', { headers: { ...headers, Cookie: '' } })).status, 401);
    assert.equal((await w.raw('confirm', { operationId: op(1), previewToken: 'a'.repeat(64), confirmed: true })).status, 503);
    assert.deepEqual(w.calls, { storage: 0, journal: 0, commit: 0, acquire: 0, base: 0 });
  });
  test('signed login, authorization, strict origin and exact bounded JSON guards', async t => {
    const w = await startWorld(); t.after(w.close);
    const signed = payload => {
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return 'hfd_session=' + body + '.' + crypto.createHmac('sha256', env.SESSION_SECRET).update(body).digest('base64url');
    };
    for (const cookie of ['', w.cookie + 'tampered', signed({ exp: Date.now() - 1, sid: 'a'.repeat(64) }), signed({ exp: Date.now() + 10000 })]) {
      const r = await w.raw('selections', {}, { headers: { Cookie: cookie, Authorization: 'Bearer synthetic-only' } });
      assert.equal(r.status, 401);
    }
    for (const extra of [{ Origin: 'http://evil.test' }, { Origin: '', Host: new URL(w.origin).host }, { 'X-Atlas-Settlement': '' }]) {
      const r = await w.raw('selections', {}, { headers: { Cookie: w.cookie, Origin: w.origin,
        'Content-Type': 'application/json', 'X-Atlas-Settlement': 'same-origin', ...extra } });
      assert.equal(r.status, 403); assert.equal(r.headers.get('access-control-allow-origin'), null);
    }
    for (const body of [{ actorId: 'x' }, { householdId }, { namespace: 'x' }, { receipt: {} }, { witness: {} }, { rawCommand: {} }]) {
      assert.equal((await w.raw('selections', body)).status, 400);
    }
    assert.equal((await w.raw('selections?operationId=' + op(1), {})).status, 400);
    assert.equal((await w.raw('selections', { padding: 'x'.repeat(5000) })).status, 400);
    assert.equal(w.calls.storage, 0); assert.equal(w.calls.acquire, 0);
    w.authorized = false;
    assert.equal((await w.raw('selections', {})).status, 503);
    assert.equal(w.calls.storage, 0);
  });
  test('actual HTTP catalogue, read-only preview, retained controller, duplicate confirm and restart receipt', async t => {
    const w = await startWorld(); t.after(w.close);
    const p = await w.prepare(); assert.equal(p.status, 'prepared'); assert.equal(p.assignedCents, 2500);
    assert.equal(w.calls.journal, 0); assert.equal(w.calls.commit, 0);
    assert.equal(p.labels.payment, 'Synthetic recorded club payment');
    const [a, b] = await Promise.all([w.confirm(p), w.confirm(p)]);
    assert.ok([a.status, b.status].includes('committed')); assert.equal(w.calls.commit, 1);
    const original = await w.post('outcome', { operationId: op(1) }); assert.equal(original.status, 'committed');
    w.recreate(); assert.deepEqual(await w.post('outcome', { operationId: op(1) }), original);
    const view = await w.post('publication', { operationId: op(1) });
    assert.equal(view.publication, 'included');
    const evidence = view.data.settlementEvidence.commitments[0];
    assert.equal(evidence.links[0].assignedCents, 2500);
    const options = { asOf: w.base.meta.asOf, currentPeriodActuals: w.base.liveOverlay.currentPeriodActuals,
      settlementEvidenceStatus: view.data.settlementEvidenceStatus, settlementEvidence: view.data.settlementEvidence };
    const result = Forecast.savingsInventory(view.data.plan, w.base.meta.asOf, options);
    const goal = result.pools.flatMap(x => x.plannedGoals).find(x => x.key === 'commitment:near');
    assert.equal(goal.target, 60);
    assert.equal(goal.linkedPaid, 25);
    assert.equal(goal.remaining, 35);
    w.cookie = await w.login();
    assert.equal((await w.post('outcome', { operationId: op(1) })).status, 'unknown');
    assert.equal((await w.post('publication', { operationId: op(1) })).status, 'unknown');
    assert.equal(w.calls.commit, 1);
  });
  test('stale and ambiguous catalogue selections refuse without writes', async t => {
    const w = await startWorld(); t.after(w.close);
    const selection = await w.selection();
    w.acquisition.packet.transactions[0].amount = 61;
    const refused = await w.post('prepare', { operationId: op(1), selection, assignedCents: 2500 });
    assert.equal(refused.status, 'unavailable');
    w.acquisition.join.push({ localId: 'synthetic-row', providerAccountId: 'SYNTHETIC-OTHER', transactionId: 'SYNTHETIC-OTHER' });
    assert.deepEqual((await w.post('selections', {})).transactions, []);
    assert.equal(w.calls.commit, 0); assert.equal(w.calls.journal, 0);
  });
  test('mutable monotonic context revision/domain fences real store pre-write admission', async t => {
    const w = await startWorld(); t.after(w.close);
    for (const [n, mutate] of [[1, () => w.cell.revision++], [2, () => { w.cell.domain = 'different-domain'; }]]) {
      const p = await w.prepare(n); assert.equal(p.status, 'prepared');
      w.hooks.admission = mutate;
      assert.deepEqual(await w.confirm(p), { status: 'rejected', reason: 'admission-refused' });
      assert.equal(w.calls.journal, 0);
    }
  });
  test('publication deep snapshot, single acquisition, unavailable recovery and post-await revocation', async t => {
    const w = await startWorld(); t.after(w.close);
    const p = await w.prepare(); assert.equal((await w.confirm(p)).status, 'committed');
    let reads = 0;
    w.hooks.document = async () => {
      reads++;
      if (reads === 1) w.base.plan.commitments[0].label = 'Mutated after snapshot';
    };
    w.base.settlementEvidence = { hostile: true }; w.base.settlementEvidenceStatus = { status: 'qualified' };
    const view = await w.post('publication', { operationId: op(1) });
    assert.equal(reads, 2, 'one loader acquisition, including its own stability re-read');
    assert.equal(view.data.plan.commitments[0].label, 'Invented first club cost');
    assert.equal(view.publication, 'included'); assert.equal(view.data.settlementEvidence.hostile, undefined);
    w.readFailure = true;
    const unavailable = await w.post('publication', { operationId: op(1) });
    assert.equal(unavailable.status, 'committed'); assert.equal(unavailable.publication, 'unavailable');
    assert.equal(unavailable.data.settlementEvidenceStatus.reason, 'pin-unavailable');
    assert.equal(unavailable.data.settlementEvidence, undefined);
    w.readFailure = false;
    assert.equal((await w.post('publication', { operationId: op(1) })).publication, 'included');
    w.hooks.pin = async () => { w.authorized = false; };
    const revoked = await w.raw('publication', { operationId: op(1) });
    assert.equal(revoked.status, 503); assert.deepEqual(await revoked.json(), { status: 'unavailable' });
    assert.equal(w.calls.commit, 1);
  });
  test('actual refresh witness rejects HTTP confirmation after revision drift or joined reader-domain change', async t => {
    // The only provider-shaped endpoint is a local synthetic HTTP double. Real
    // refresh workers mint the actual witness; no external provider is called.
    const helper = require('./test-server-observation-memory');
    const Fixture = require('./fixtures/budget-surface-data');
    const Refresh = require('../scripts/server-live-refresh');
    const mock = await helper.provider(); t.after(() => mock.close());
    const originalNow = Date.now; Date.now = () => Date.parse(helper.CLOCK);
    t.after(() => { Date.now = originalNow; });
    const w = await startWorld(); t.after(w.close);
    const canonical = Fixture.canonical(), refreshEnv = helper.environment(mock.base);
    const cell = { canonical, env: refreshEnv, contextRevision: 1 };
    const reader = () => ({ ...cell });
    w.base = await Refresh.serve(canonical, refreshEnv);
    assert.equal(w.base.liveOverlay.applied, true);
    const seedCalls = mock.calls.length;
    let domainMismatch = false;
    w.dependency.contextReader = reader;
    w.syntheticAcquire = async configuredReader => {
      let paired;
      if (domainMismatch) {
        const foreignReader = () => ({ ...cell });
        const first = Refresh.acquireSettlementWithWitness(canonical, refreshEnv, { contextReader: foreignReader });
        const second = Refresh.acquireSettlementWithWitness(canonical, refreshEnv, { contextReader: configuredReader });
        paired = (await Promise.all([first, second]))[1];
      } else paired = await Refresh.acquireSettlementWithWitness(canonical, refreshEnv, { contextReader: configuredReader });
      return { ...paired.acquisition, witness: paired.witness };
    };
    w.recreate();
    const selection = async () => {
      const c = await w.post('selections', {});
      const a = await w.syntheticAcquire(reader);
      const transaction = R.deriveSelectionHandle(R.computeInstanceDigest(a.packet),
        { householdId, providerAccountId: '1002', transactionId: '92003' });
      const commitment = R.deriveChoiceHandle(R.computePlanDigest(a.plan), 'commitment:school-trip');
      assert.ok(c.transactions.some(x => x.handle === transaction));
      return { transaction, commitment };
    };
    const selections = await selection();
    for (const n of [1, 2]) {
      const p = await w.post('prepare', { operationId: op(n), selection: selections, assignedCents: 1000 });
      assert.equal(p.status, 'prepared');
      if (n === 1) w.hooks.admission = () => { cell.contextRevision++; };
      else { w.hooks.admission = null; domainMismatch = true; }
      assert.deepEqual(await w.confirm(p), { status: 'rejected', reason: 'admission-refused' });
      assert.equal(w.calls.journal, 0);
    }
    assert.equal(mock.calls.length, seedCalls, 'all acquisition replays made zero additional local mock GETs');
  });
  test('purchase assignment preserves unresolved card opening and coverage holds in the complete view', async t => {
    const w = await startWorld(); t.after(w.close);
    w.base.liveOverlay.currentPeriodActuals.cardCoverageRequired = true;
    w.acquisition.packet.cardCoverageRequired = true;
    const coverage = data => Forecast.recommend(data.plan, data.meta.asOf,
      { ...data.liveOverlay, debts: data.debts, weeklyVariable: 0,
        ...(data.settlementEvidence ? { settlementEvidence: data.settlementEvidence } : {}) }).cardPurchaseCoverage;
    const before = coverage(w.base);
    assert.equal(before.status, 'unavailable'); assert.equal(before.reservedCash, null);
    const p = await w.prepare(); assert.equal(p.status, 'prepared');
    assert.equal((await w.confirm(p)).status, 'committed');
    const view = await w.post('publication', { operationId: op(1) });
    assert.equal(view.publication, 'included');
    assert.deepEqual(coverage(view.data), before);
    assert.deepEqual(view.data.liveOverlay, w.base.liveOverlay);
    assert.equal(view.data.plan.cardPurchaseCoverage, undefined, 'no opening or payment allocation invented');
    const goal = Forecast.savingsInventory(view.data.plan, view.data.meta.asOf,
      { settlementEvidence: view.data.settlementEvidence }).pools[0].plannedGoals[0];
    assert.deepEqual([goal.target, goal.linkedPaid, goal.remaining], [60, 25, 35]);
  });
  test('publication retains its included snapshot when a second commit interleaves before response', async t => {
    const w = await startWorld(); t.after(w.close);
    assert.equal((await w.confirm(await w.prepare())).status, 'committed');
    w.acquisition.packet.transactions.push({ ...w.acquisition.packet.transactions[0], id: 'synthetic-second-row' });
    w.acquisition.join.push({ localId: 'synthetic-second-row', providerAccountId: 'SYNTHETIC-ACCOUNT', transactionId: 'SYNTHETIC-SECOND-TRANSACTION' });
    const catalogue = await w.post('selections', {});
    const second = await w.post('prepare', { operationId: op(2), assignedCents: 1000,
      selection: { transaction: catalogue.transactions[1].handle, commitment: catalogue.commitments[1].handle } });
    assert.equal(second.status, 'prepared');
    let authorizations = 0, reads = 0;
    w.hooks.document = async () => { reads++; };
    w.hooks.authorize = async () => {
      authorizations++;
      if (authorizations === 4) assert.equal((await w.confirm(second)).status, 'committed');
    };
    const firstView = await w.post('publication', { operationId: op(1) });
    assert.equal(w.calls.commit, 2); assert.equal(reads, 2);
    assert.equal(firstView.publication, 'included');
    assert.equal(firstView.data.settlementEvidence.commitments.length, 1, 'no ordinary attach after receipt inclusion');
    w.hooks.authorize = null;
    const later = await w.post('publication', { operationId: op(1) });
    assert.equal(later.publication, 'included'); assert.equal(later.data.settlementEvidence.commitments.length, 2);
  });
  test('incumbent node test/test-local.js against actual default executable startup', async t => {
    const { spawn } = require('node:child_process');
    const net = require('node:net');
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const clean = {};
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT'])
      if (process.env[key]) clean[key] = process.env[key];
    const child = spawn(process.execPath, ['server.js'], { cwd: require('node:path').resolve(__dirname, '..'),
      env: { ...clean, ...env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
    t.after(() => child.kill());
    const base = 'http://127.0.0.1:' + port;
    let ready = false;
    for (let n = 0; n < 100; n++) {
      try { if ((await fetch(base + '/healthz')).ok) { ready = true; break; } } catch { /* local startup */ }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(ready, 'default executable is listening');
    const smoke = spawn(process.execPath, ['test/test-local.js'], { cwd: require('node:path').resolve(__dirname, '..'),
      env: { ...clean, TEST_BASE: base, TEST_PASSWORD: env.SITE_PASSWORD }, windowsHide: true });
    let output = ''; smoke.stdout.on('data', value => { output += value; }); smoke.stderr.on('data', value => { output += value; });
    const code = await new Promise(resolve => smoke.on('exit', resolve));
    assert.equal(code, 0, output); assert.match(output, /ALL CHECKS PASSED/);
    const signed = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: env.SITE_PASSWORD }) });
    const capability = await fetch(base + '/settlement/capability', { headers: {
      Cookie: signed.headers.get('set-cookie').split(';')[0],
      'X-Atlas-Settlement': 'same-origin', 'Sec-Fetch-Site': 'same-origin' } });
    assert.deepEqual(await capability.json(), { status: 'inactive', bootClassification: 'preactivation-only' });
    assert.equal(capability.headers.get('cache-control'), 'no-store');
  });
  test('deterministic preview expiry refuses mounted confirm with zero write attempts', async t => {
    let clock = Date.now();
    const w = await startWorld(true, { now: () => clock }); t.after(w.close);
    const p = await w.prepare(); assert.equal(p.status, 'prepared');
    assert.ok(p.expiresAt > clock);
    clock = p.expiresAt;
    assert.deepEqual(await w.confirm(p), { status: 'rejected', reason: 'preview-expired' });
    assert.equal(w.calls.commit, 0); assert.equal(w.calls.journal, 0);
    assert.equal((await w.post('outcome', { operationId: p.operationId })).status, 'unknown');
  });
  for (const kind of ['cookie', 'authorization']) {
    test(kind + ' expiry during awaited publication returns no unauthorized view', async t => {
      const w = await startWorld(); t.after(w.close);
      const p = await w.prepare(); assert.equal((await w.confirm(p)).status, 'committed');
      let reached, release;
      const entered = new Promise(resolve => { reached = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      let policyClock = 1;
      const policyExpiry = 2;
      if (kind === 'authorization') w.hooks.authorize = async () => {
        if (policyClock >= policyExpiry) throw new Error('synthetic authorization expired');
      };
      w.hooks.pin = async () => { reached(); await gate; };
      const originalNow = Date.now;
      try {
        const pending = w.raw('publication', { operationId: p.operationId });
        await entered;
        if (kind === 'cookie') {
          const payload = JSON.parse(Buffer.from(w.cookie.slice('hfd_session='.length).split('.')[0], 'base64url'));
          Date.now = () => payload.exp + 1;
        } else policyClock = policyExpiry;
        release();
        const response = await pending;
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { status: 'unavailable' }, 'no data, receipt or successful acknowledgement leaves the expired authority');
        assert.equal(w.calls.commit, 1); assert.equal(w.calls.journal, 1);
      } finally { Date.now = originalNow; release(); }
    });
  }
}
