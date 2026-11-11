'use strict';
// Period-history capture in production logged
//   {"type":"period-history-capture","closing":"history-store-unavailable","opening":"history-store-unavailable"}
// every time, while the main-thread read in the same second logged
//   {"type":"period-history-read","outcome":"read","records":0}.
// The writer role has CONNECTION LIMIT 1, and the read refresh and the capture
// offer are triggered by the same served refresh a millisecond apart, so they
// collided on every attempt; and the capture log line dropped the connection
// owner's sanitized diagnostic, so the cause could not be seen.
//
//   D1 the diagnostic is re-validated to three fixed fields; anything else is dropped
//   D2 the capture log line carries those fixed fields and never driver text
//   D3 the worker's message carries the diagnostic from open, read and append failures
//   D4 reproduction: without the shared gate, an overlapping read and capture
//      collide: the log pair above, with diagnostic {connect, sql, 53300}
//   D5 with the gate, a read in flight makes the capture skip without spending
//      its retry window, and the next offer captures
//   D6 the gate is released on every path (error, throw, timeout)
//
// Offline: injected pg.Client double with CONNECTION LIMIT 1, invented data.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Capture = require('../scripts/period-history-refresh-capture');
const Read = require('../scripts/period-history-read');
const Gate = require('../scripts/period-history-session-gate');
const Pg = require('../scripts/private-period-history-postgres');
const { pgWorld, URL_VALUE, CANARY } = require('./fixtures/period-history-pg-double');
const { START, NEXT, input } = require('./fixtures/private-period-history-input');

const TRUST = /^(?:PG.*|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|NODE_USE_SYSTEM_CA|SSL_CERT_FILE|SSL_CERT_DIR|OPENSSL_.*)$/i;
const skip = Object.keys(process.env).some(k => TRUST.test(k))
  ? 'UNRUN: process environment carries TLS-trust variables the connection owner refuses; run with them unset' : false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Wait for a condition, not a fixed time: the real capture work (hashing,
// chain verification) takes a variable few hundred milliseconds.
async function until(condition, label, ms = 8000) {
  const end = Date.now() + ms;
  while (!condition()) { if (Date.now() > end) assert.fail('timed out waiting for ' + label); await sleep(10); }
}
const ENV = { [Pg.ENV_NAME]: URL_VALUE, [Capture.FLAG]: 'on' };

function evidence(day) {
  const raw = input({ day, cash: [1000, 500, 100], periodStart: START });
  delete raw.kind; delete raw.periodStart;
  const at = raw.capturedAt; delete raw.capturedAt;
  return { raw, now: () => new Date(at) };
}

// A pg double whose role has CONNECTION LIMIT 1: a connection that arrives
// while a session is open is refused with SQLSTATE 53300, as PostgreSQL does.
// Each statement takes a little network time, so a session is held for a while.
function limitedWorld() {
  let active = 0;
  const world = pgWorld();
  class Net extends world.Client {
    async connect() {
      await sleep(8);
      if (active >= 1) throw Object.assign(new Error(CANARY), { code: '53300' });
      active++; this.live = true;
    }
    async query(text, values) { await sleep(10); return super.query(text, values); }
    async end() { if (this.live) { this.live = false; active--; } return super.end(); }
  }
  return { world, Client: Net };
}
const openStore = Client => () => Pg.openPeriodHistoryPostgres({ env: ENV, Client });
// A worker that runs the real worker function in-process against the double.
function inProcessSpawn(Client, day = NEXT) {
  return (data, env) => {
    const worker = new EventEmitter(); worker.terminate = async () => {};
    const ev = evidence(day);
    Capture.runWorker({ canonical: data.canonical, payload: data.payload, env, open: openStore(Client),
      buildInput: () => ev.raw, now: ev.now }).then(message => worker.emit('message', message));
    return worker;
  };
}
const offerArgs = day => ({ canonical: { invented: true }, evidence: { payload: { invented: true } }, env: ENV, day });

test('D1 the diagnostic is re-validated to three fixed fields; anything else is dropped', () => {
  const ok = { stage: 'connect', category: 'sql', code: '53300' };
  assert.deepEqual(Capture.cleanDiagnostic(ok), ok);
  assert.deepEqual(Capture.cleanDiagnostic({ stage: 'tls', category: 'tls', code: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
    { stage: 'tls', category: 'tls', code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  assert.deepEqual(Capture.cleanDiagnostic({ stage: 'environment', category: 'environment', code: null }),
    { stage: 'environment', category: 'environment', code: null });
  for (const bad of [null, undefined, 'connect', 7, [], { stage: 'connect', category: 'sql' },
    { ...ok, message: 'password authentication failed for user "x"' }, { ...ok, extra: 1 },
    { stage: 'Connect failed: host db.example.test', category: 'sql', code: '53300' },
    { stage: 'connect', category: 'sql', code: 'too many connections for role "atlas"' },
    { stage: 'connect', category: 'sql', code: '53300'.padEnd(80, '0') },
    { stage: 'connect', category: 'sql', code: 53300 }, Object.assign(Object.create({ stage: 'connect' }), ok)])
    assert.equal(Capture.cleanDiagnostic(bad), null, JSON.stringify(bad));
  assert.equal(Capture.cleanDiagnostic({ get stage() { throw new Error('getter'); }, category: 'sql', code: null }), null);
});

test('D2 the capture log line carries the fixed diagnostic fields and never driver text', () => {
  const lines = [];
  let worker;
  const owner = Capture.create({ gate: Gate.create(), spawn: () => { worker = new EventEmitter(); worker.terminate = async () => {}; return worker; },
    log: line => lines.push(JSON.parse(line)) });
  assert.equal(owner.offer(offerArgs('2030-02-15')), 'started');
  return until(() => worker, 'the deferred worker start').then(() => {
    worker.emit('message', { closing: 'history-store-unavailable', opening: 'history-store-unavailable',
      diagnostic: { stage: 'connect', category: 'sql', code: '53300', message: 'FATAL: too many connections ' + CANARY } });
    assert.deepEqual(lines, [{ type: 'period-history-capture', closing: 'history-store-unavailable', opening: 'history-store-unavailable' }],
      'a diagnostic with any extra field is dropped whole, never partly logged');
    assert.ok(!JSON.stringify(lines).includes(CANARY));
  });
});

test('D3 the worker message carries the diagnostic from an open, read or append failure', { skip }, async () => {
  const refused = Object.assign(new Error('history-store-unavailable'), { code: 'history-store-unavailable',
    diagnostic: Object.freeze({ stage: 'connect', category: 'sql', code: '53300' }) });
  const ev = evidence(NEXT);
  const base = { canonical: {}, payload: {}, env: ENV, buildInput: () => ev.raw, now: ev.now };
  // open fails
  assert.deepEqual(await Capture.runWorker({ ...base, open: async () => { throw refused; } }),
    { closing: 'history-store-unavailable', opening: 'history-store-unavailable', diagnostic: { stage: 'connect', category: 'sql', code: '53300' } });
  // the first read fails
  const store = (over) => ({ read: async () => [], append: async () => ({ status: 'appended' }), retire: async () => {}, ...over });
  assert.deepEqual(await Capture.runWorker({ ...base, open: async () => store({ read: async () => { throw refused; } }) }),
    { closing: 'history-store-unavailable', opening: 'history-store-unavailable', diagnostic: { stage: 'connect', category: 'sql', code: '53300' } });
  // an append fails
  assert.deepEqual(await Capture.runWorker({ ...base, open: async () => store({ append: async () => { throw refused; } }) }),
    { closing: 'history-store-unavailable', opening: 'history-store-unavailable', diagnostic: { stage: 'connect', category: 'sql', code: '53300' } });
  // a plain code-only failure keeps its old shape: no diagnostic key
  const plain = Object.assign(new Error('history-store-unconfigured'), { code: 'history-store-unconfigured' });
  assert.deepEqual(await Capture.runWorker({ ...base, open: async () => { throw plain; } }),
    { closing: 'history-store-unconfigured', opening: 'history-store-unconfigured' });
  // a hostile diagnostic on the error never reaches the message
  const hostile = Object.assign(new Error('history-store-unavailable'), { code: 'history-store-unavailable',
    diagnostic: { stage: 'connect', category: 'sql', code: '53300', detail: CANARY } });
  const out = await Capture.runWorker({ ...base, open: async () => { throw hostile; } });
  assert.deepEqual(out, { closing: 'history-store-unavailable', opening: 'history-store-unavailable' });
});

test('D4 reproduction: without a shared gate an overlapping read and capture collide, and the log now says why', { skip }, async () => {
  const { world, Client } = limitedWorld();
  const readLines = [], captureLines = [];
  const read = Read.create({ env: ENV, openStore: openStore(Client), log: line => readLines.push(JSON.parse(line)), gate: Gate.create() });
  const capture = Capture.create({ gate: Gate.create(), spawn: inProcessSpawn(Client), log: line => captureLines.push(JSON.parse(line)) });
  read.withHistory({ a: 1 });                       // the served refresh: the read starts
  assert.equal(capture.offer(offerArgs('2030-02-15')), 'started'); // and the capture is offered in the same turn
  await until(() => readLines.length === 1 && captureLines.length === 1, 'the read and the refused capture');
  assert.deepEqual(readLines, [{ type: 'period-history-read', outcome: 'read', records: 0 }], 'the read opens fine');
  assert.deepEqual(captureLines, [{ type: 'period-history-capture', closing: 'history-store-unavailable', opening: 'history-store-unavailable',
    diagnostic: { stage: 'connect', category: 'sql', code: '53300' } }], 'the capture is refused, and the line names the cause');
  assert.ok(!JSON.stringify(captureLines).includes(CANARY));
  assert.equal(world.committed.length, 0, 'nothing was saved');
  // The same capture on its own succeeds: the refusal was the overlap, not the store.
  const alone = [];
  const later = Capture.create({ gate: Gate.create(), spawn: inProcessSpawn(Client), log: line => alone.push(JSON.parse(line)) });
  assert.equal(later.offer(offerArgs('2030-02-15')), 'started');
  await until(() => alone.length === 1, 'the capture on its own');
  assert.deepEqual(alone, [{ type: 'period-history-capture', closing: 'appended', opening: 'appended' }]);
  assert.equal(world.committed.length, 2);
});

test('D5 with the shared gate a read in flight makes the capture skip, and the next offer captures', { skip }, async () => {
  const { world, Client } = limitedWorld();
  const gate = Gate.create();
  const readLines = [], captureLines = [];
  const read = Read.create({ env: ENV, openStore: openStore(Client), log: line => readLines.push(JSON.parse(line)), gate });
  const capture = Capture.create({ gate, spawn: inProcessSpawn(Client), log: line => captureLines.push(JSON.parse(line)) });
  read.withHistory({ a: 1 });
  assert.equal(capture.offer(offerArgs('2030-02-15')), 'busy', 'the read holds the one session');
  await until(() => readLines.length === 1, 'the read');
  assert.deepEqual(readLines, [{ type: 'period-history-read', outcome: 'read', records: 0 }]);
  assert.deepEqual(captureLines, [], 'a skipped offer logs nothing and starts nothing');
  // The skipped offer did not spend the retry window: the next offer starts at once.
  assert.equal(capture.offer(offerArgs('2030-02-15')), 'started');
  await until(() => captureLines.length === 1, 'the capture');
  assert.deepEqual(captureLines, [{ type: 'period-history-capture', closing: 'appended', opening: 'appended' }]);
  assert.equal(world.committed.length, 2, 'one closing and one baseline saved');
  // And the other way round: a capture in flight makes the read skip, then it reads.
  const gate2 = Gate.create(); const w2 = limitedWorld();
  const lines2 = [], reads2 = [];
  const cap2 = Capture.create({ gate: gate2, spawn: inProcessSpawn(w2.Client), log: line => lines2.push(JSON.parse(line)) });
  const read2 = Read.create({ env: ENV, openStore: openStore(w2.Client), log: line => reads2.push(JSON.parse(line)), gate: gate2, clock: () => 0 });
  assert.equal(cap2.offer(offerArgs('2030-02-15')), 'started');
  read2.withHistory({ a: 1 });
  await until(() => lines2.length === 1, 'the capture');
  assert.deepEqual(reads2, [], 'a read that finds the capture in flight skips this round');
  assert.deepEqual(lines2, [{ type: 'period-history-capture', closing: 'appended', opening: 'appended' }]);
  read2.withHistory({ a: 1 });
  await until(() => reads2.length === 1, 'the next read');
  assert.equal(reads2.length, 1, 'the next served page reads');
  assert.equal(reads2[0].outcome, 'read');
  assert.equal(reads2[0].records, 2, 'and sees the two records the capture saved');
});

test('D6 the gate is released on every path', async () => {
  const gate = Gate.create();
  const lines = [];
  // a spawn that throws
  const throwing = Capture.create({ gate, spawn: () => { throw new Error('PRIVATE'); }, log: line => lines.push(JSON.parse(line)) });
  assert.equal(throwing.offer(offerArgs('2030-02-15')), 'started');
  await until(() => lines.length === 1, 'the failed start to be logged');
  assert.ok(gate.tryAcquire(), 'free after a spawn that throws');
  // a worker error event
  const gate2 = Gate.create(); let worker;
  const erroring = Capture.create({ gate: gate2, spawn: () => { worker = new EventEmitter(); worker.terminate = async () => {}; return worker; }, log: line => lines.push(JSON.parse(line)) });
  assert.equal(erroring.offer(offerArgs('2030-02-15')), 'started');
  await until(() => worker, 'the deferred worker start');
  assert.equal(gate2.tryAcquire(), null, 'held while the capture runs');
  worker.emit('error', new Error('PRIVATE'));
  assert.ok(gate2.tryAcquire(), 'free after a worker error');
  // a worker that exits without a message
  const gate3 = Gate.create(); let w3;
  const exiting = Capture.create({ gate: gate3, spawn: () => { w3 = new EventEmitter(); w3.terminate = async () => {}; return w3; }, log: line => lines.push(JSON.parse(line)) });
  assert.equal(exiting.offer(offerArgs('2030-02-15')), 'started');
  await until(() => w3, 'the deferred worker start');
  w3.emit('exit', 1);
  assert.ok(gate3.tryAcquire(), 'free after an exit with no message');
  assert.ok(lines.every(l => l.closing === 'history-capture-failed' && l.opening === 'history-capture-failed' && !('diagnostic' in l)),
    'failures without a diagnostic log exactly as before');
  assert.ok(!JSON.stringify(lines).includes('PRIVATE'));
  // the gate itself: one holder, release is idempotent
  const g = Gate.create(); const release = g.tryAcquire();
  assert.equal(g.tryAcquire(), null); release(); release();
  const again = g.tryAcquire(); assert.ok(again); assert.equal(g.tryAcquire(), null); again();
});
