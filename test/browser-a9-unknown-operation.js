'use strict';
// Plan #6 A9 combined-path proof, File 2 of 2 — TEST ONLY (browser).
// The visible consumer half of the A9 scenario whose HTTP half is
// test/test-a9-unknown-operation-host.js (File 1): the ACTUAL
// production host (createSettlementProductionHost) composed by the real
// startServer, driven over real HTTP to build the world, then the real
// plan page in Chromium at 390px. Assertions follow Atlas's corrected
// consumer-state freeze (issue #787 ruling 6507359473), NOT the scope
// packet's withdrawn blanket no-green/no-retirement oracle.
// The synthetic pg world below mirrors File 1 /
// test/test-settlement-production-host.js on main; SQL/TLS, provider
// acquisition and refresh are OFFLINE SYNTHETIC DOUBLES and the encrypt
// seam is the host factory's labelled synthetic cipher. Nothing here is
// live, Postgres, or target qualification.
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');
const { EventEmitter } = require('node:events');

const householdId = 'household-' + 'a'.repeat(32);
const FIN_USER = 'settlement_financial';
const AUTH_USER = 'settlement_auth';
const CUSTODY_USER = 'settlement_custody';
const exclusionDomain = {
  ledgerNamespace: 'ledger-' + '1'.repeat(32),
  serializationAuthority: 'authority-' + '2'.repeat(32),
  historyAuthority: 'authority-' + '3'.repeat(32),
};
const syntheticPassword = 'synthetic-host-password';
const syntheticSessionSecret = 'synthetic-host-session-secret';
const appEnv = { SITE_PASSWORD: syntheticPassword,
  SESSION_SECRET: syntheticSessionSecret, ATLAS_LIVE_OVERLAY: 'live' };
const canary = 'SYNTHETIC-CONFIG-SECRET-CANARY';
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const clone = x => structuredClone(x);
const C = require('../scripts/planned-obligation-settlement-contract');
// GAP-1 suite's own synthetic encryption pattern: a labelled test
// double, never a production cipher.
const syntheticEncrypt = async bytes =>
  Buffer.concat([Buffer.from('SYNTHETIC-CIPHER:'), Buffer.from(bytes)]);

// --- Synthetic pg world (adapted from the composition suite) --------
let active = null;
const setActive = w => { active = w; };
function metadata(kind) {
  const tables = kind === 'financial' ? ['doc_head', 'doc_staged', 'journal', 'quarantine'].map(name => ({ name, kind: 'r', persistence: 'p',
      rls: false, forceRls: false, unsafe: false, primaryKeyCount: 1,
      columns: (name === 'quarantine' ? ['scope', 'name', 'label', 'bytes'] : ['scope', 'bytes']).map(name =>
        ({ name, type: name === 'bytes' ? 'bytea' : 'text', notNull: name !== 'label', generated: '' })),
      primaryKey: name === 'quarantine' ? ['scope', 'name'] : ['scope'] }))
    : Object.entries({ auth_eligibility: [['scope', 'text'], ['household_id', 'text'], ['operation_id', 'text'],
        ['generation', 'text'], ['confirmation_digest', 'text'], ['secret_digest', 'text'], ['issued_at', 'bigint']],
      auth_revocation: [['scope', 'text'], ['operation_id', 'text'], ['generation', 'text'], ['revoked_at', 'bigint']],
      auth_session_revocation: [['scope', 'text'], ['sid_digest', 'text'], ['revoked_at', 'bigint']] })
      .map(([name, columns]) => ({ name, kind: 'r', persistence: 'p', rls: false, forceRls: false, unsafe: false, primaryKeyCount: 1,
        columns: columns.map(([name, type]) => ({ name, type, notNull: true, generated: '' })),
        primaryKey: name === 'auth_session_revocation' ? ['scope', 'sid_digest'] : ['scope', 'operation_id', 'generation'] }));
  if (kind === 'financial' && active && active.nativeHistory) {
    tables.push({ name: 'terminal_history', kind: 'r', persistence: 'p',
      rls: false, forceRls: false, unsafe: false, primaryKeyCount: 1,
      columns: [['scope', 'text'], ['history_bytes', 'bytea'], ['checkpoint_bytes', 'bytea']]
        .map(([name, type]) => ({ name, type, notNull: true, generated: '' })),
      primaryKey: ['scope'] });
  }
  return [
    [{ database: 'synthetic', user: kind + '_app', pid: kind === 'financial' ? 301 : 302, searchPath: 'pg_catalog' }],
    [{ canLogin: true, superuser: false, createDb: false, createRole: false, inherit: false,
      replication: false, bypassRls: false, connectionLimit: 1, memberships: 0, ownedObjects: 0 }],
    [{ connect: true, schemaUsage: true, databaseCreate: false, schemaCreate: false, tables: true, functions: true }],
    tables,
  ];
}
function custodySchemaRows(w) {
  const col = (name, type) => ({ name, type, notNull: true, generated: '' });
  const pin = { name: 'custody_pin', kind: 'r', persistence: 'p', rls: false, forceRls: false,
    unsafe: false, primaryKeyCount: 1,
    columns: [col('scope', 'text'), col('household', 'text'), col('bytes', 'bytea')],
    primaryKey: ['scope'] };
  const backup = { name: 'custody_backup', kind: 'r', persistence: 'p', rls: false, forceRls: false,
    unsafe: false, primaryKeyCount: 1,
    columns: [col('scope', 'text'), col('household', 'text'), col('revision', 'text'),
      col('digest', 'text'), col('bytes', 'bytea'), col('integrity', 'text')],
    primaryKey: ['scope', 'revision', 'digest'] };
  switch (w.custodySchemaMode) {
    case 'unlogged': return [{ ...backup }, { ...pin, persistence: 'u' }];
    case 'rls': return [{ ...backup }, { ...pin, rls: true }];
    case 'missing': return [{ ...pin }];
    case 'extra': return [{ ...backup }, { ...pin }, { ...pin, name: 'surprise' }];
    default: return [{ ...backup }, { ...pin }];
  }
}
function custodyQuery(w, text, values) {
  const result = (rows = [], rowCount = 0) => ({ command: text.split(' ')[0], rows, rowCount });
  if (text.startsWith('SELECT current_database()')) {
    return result([{ database: 'atlas', user: CUSTODY_USER, pid: 303, searchPath: 'pg_catalog' }]);
  }
  if (text.includes('pg_roles')) {
    return result([{ canLogin: true, superuser: false, createDb: false, createRole: false,
      inherit: false, replication: false, bypassRls: false, connectionLimit: 1,
      memberships: 0, ownedObjects: 0 }]);
  }
  if (text.includes('has_database_privilege')) {
    return result([{ connect: true, schemaUsage: true, databaseCreate: false,
      schemaCreate: false, tables: w.custodyGrantsOk !== false }]);
  }
  if (text.includes('pg_class')) return result(custodySchemaRows(w));
  if (text.includes('custody_pin')) {
    if (text.startsWith('SELECT')) {
      return result(w.pinRow ? [{ household: w.pinRow.household, bytes: w.pinRow.bytes }] : []);
    }
    if (text.startsWith('INSERT')) {
      if (w.pinRow) { const e = new Error('duplicate key'); e.code = '23505'; throw e; }
      w.pinRow = { household: values[1], bytes: Buffer.from(values[2]) };
      return result([], 1);
    }
    if (text.startsWith('UPDATE')) {
      if (w.pinRow && w.pinRow.household === values[2] && w.pinRow.bytes.equals(values[3])) {
        w.pinRow = { household: values[2], bytes: Buffer.from(values[1]) };
        return result([], 1);
      }
      return result([], 0);
    }
  }
  if (text.includes('custody_backup')) {
    if (text.startsWith('INSERT')) {
      const key = values[2] + '|' + values[3];
      if (w.backups.has(key)) return result([], 0);
      w.backups.set(key, { household: values[1], revision: values[2], digest: values[3],
        bytes: Buffer.from(values[4]), integrity: values[5] });
      return result([], 1);
    }
    if (text.startsWith('SELECT') && text.includes('revision = $2')) {
      const e = w.backups.get(values[1] + '|' + values[2]);
      return result(e ? [{ ...e }] : []);
    }
    if (text.startsWith('SELECT')) return result([...w.backups.values()].map(e => ({ ...e })));
  }
  throw Error('unmodelled synthetic custody SQL');
}
class SyntheticClient extends EventEmitter {
  constructor(config) {
    super();
    this.kind = config.user === AUTH_USER ? 'authorization'
      : config.user === CUSTODY_USER ? 'custody' : 'financial';
    this.config = config; this.ends = 0; this.count = 0; this.endEmitted = false;
    this.connection = { stream: { encrypted: true, authorized: true, servername: 'db.example.test',
      getPeerCertificate: () => ({ subjectaltname: 'DNS:db.example.test' }) } };
    active.clients.push(this); active.events.push('construct:' + this.kind);
  }
  async connect() { active.events.push('connect:' + this.kind); if (active.hooks.connect) await active.hooks.connect(this.kind); }
  async end() {
    this.ends++; active.events.push('end:' + this.kind);
    if (this.kind === 'custody' && active.custodyEndScript
      && active.custodyEndScript.length > 0) {
      const step = active.custodyEndScript.shift();
      if (step === 'rejects') throw Error(canary);
      if (step === 'hangs') return new Promise(() => {});
    }
    if (this.kind === 'custody' && active.endModeArmed) {
      if (active.custodyEndMode === 'rejects') throw Error(canary);
      if (active.custodyEndMode === 'hangs') return new Promise(() => {});
    }
    if (active.hooks.end) await active.hooks.end(this.kind);
    // Idempotent end (repair for Atlas review 2026-10-29T04:18:44Z): a
    // pg session emits 'end' at most once. The previous double emitted
    // on EVERY end(); the custody stores' loss listener ends the session
    // again on 'end', so re-emitting produced an unbounded end->emit->end
    // chain (a TEST-DOUBLE artifact, not a production deadlock claim).
    if (!this.endEmitted) { this.endEmitted = true; this.emit('end'); }
  }
  async query(text, values = []) {
    const w = active; w.sql.push({ kind: this.kind, text, values });
    if (w.hooks.query) { const v = await w.hooks.query(this.kind, text, values); if (v !== undefined) return v; }
    if (this.kind === 'custody') return custodyQuery(w, text, values);
    if (this.count++ < 4) {
      // The identity row reports THIS session's own configured
      // database/user — the factories check it against the profile.
      return { command: 'SELECT', rows: this.count === 1
        ? [{ database: this.config.database, user: this.config.user,
            pid: this.kind === 'financial' ? 301 : 302, searchPath: 'pg_catalog' }]
        : metadata(this.kind)[this.count - 1] };
    }
    const result = (rows = [], rowCount = 0) => ({ command: text.split(' ')[0], rows, rowCount });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return result();
    if (this.kind === 'authorization') {
      const key = values[1] + '|' + values[2];
      if (text.startsWith('SELECT e.household_id')) {
        const e = w.eligibility.get(key);
        const rows = [e ? { household_id: e.householdId, operation_id: e.operationId, generation: e.generation,
          confirmation_digest: e.confirmationDigest, secret_digest: e.secretDigest, issued_at: String(e.issuedAt),
          operation_revoked: w.revoked.has(key), session_revoked: w.sessions.has(values[3]) }
          : { household_id: null, operation_id: null, generation: null, confirmation_digest: null, secret_digest: null, issued_at: null,
            operation_revoked: w.revoked.has(key), session_revoked: w.sessions.has(values[3]) }];
        if (w.hooks.snapshot) await w.hooks.snapshot(rows[0], values);
        return result(rows);
      }
      if (text.startsWith('SELECT scope, household_id')) {
        const e = w.eligibility.get(key); return result(e ? [{ scope: values[0], household_id: e.householdId,
          operation_id: e.operationId, generation: e.generation, confirmation_digest: e.confirmationDigest,
          secret_digest: e.secretDigest, issued_at: String(e.issuedAt) }] : []);
      }
      if (text.startsWith('SELECT revoked_at')) return result((text.includes('auth_session_revocation')
        ? w.sessions.has(values[1]) : w.revoked.has(key)) ? [{ revoked_at: '1' }] : []);
      if (text.startsWith('INSERT INTO')) {
        if (text.includes('auth_eligibility')) w.eligibility.set(values[2] + '|' + values[3], {
          householdId: values[1], operationId: values[2], generation: values[3], confirmationDigest: values[4],
          secretDigest: values[5], issuedAt: values[6] });
        else if (text.includes('auth_session_revocation')) w.sessions.add(values[1]);
        else w.revoked.add(key);
        return result([], 1);
      }
    } else {
      if (text.includes('pg_try_advisory_lock')) return result([{ locked: true }]);
      if (text.includes('pg_advisory_unlock')) return result([{ unlocked: true }]);
      if (text.includes('pg_backend_pid')) return result([{ pid: 301 }]);
      if (text.includes('.terminal_history')) {
        if (text.startsWith('SELECT history_bytes')) {
          return result(w.terminalRow ? [{ history_bytes: w.terminalRow.historyBytes,
            checkpoint_bytes: w.terminalRow.checkpointBytes }] : []);
        }
        if (text.startsWith('UPDATE')) {
          if (w.terminalRow && w.terminalRow.historyBytes.equals(values[3])
            && w.terminalRow.checkpointBytes.equals(values[4])) {
            w.terminalRow = { historyBytes: Buffer.from(values[1]),
              checkpointBytes: Buffer.from(values[2]) };
            return result([], 1);
          }
          return result([], 0);
        }
      }
      if (text.startsWith('SELECT bytes FROM')) {
        const field = text.includes('.doc_head') ? 'doc' : text.includes('.journal') ? 'journal' : 'temp';
        return result(w[field] ? [{ bytes: Buffer.from(w[field]) }] : []);
      }
      if (text.startsWith('WITH s AS')) { w.doc = w.temp; w.temp = null; return result([], 1); }
      if (text.startsWith('INSERT INTO')) {
        if (text.includes('.quarantine')) throw Error('synthetic maintenance forbidden');
        w[text.includes('.doc_staged') ? 'temp' : 'journal'] = Buffer.from(values[1]); return result([], 1);
      }
      if (text.startsWith('DELETE FROM')) { w[text.includes('.journal') ? 'journal' : 'temp'] = null; return result([], 1); }
    }
    throw Error('unmodelled synthetic SQL');
  }
}
// The host binds require('pg').Client; stub the driver in THIS process
// before the host (or anything binding it) is loaded.
const pgPath = require.resolve('pg', { paths: [path.join(__dirname, '..')] });
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true,
  exports: { Client: SyntheticClient } };

const Refresh = require('../scripts/server-live-refresh');
const Server = require('../server');
const { startServer } = Server;
const { createSettlementProductionHost } = require('../scripts/settlement-production-host');
const Owners = require('../scripts/settlement-production-owners');
const op = n => 'operation-' + n.toString(16).padStart(32, '0');

function makeWorld() {
  const w = { time: Date.now(), clients: [], sql: [], events: [], hooks: {},
    eligibility: new Map(), revoked: new Set(), sessions: new Set(),
    doc: null, journal: null, temp: null,
    pinRow: null, backups: new Map(), custodySchemaMode: 'ok',
    custodyGrantsOk: true, custodyEndMode: 'ok', endModeArmed: false,
    custodyEndScript: null,
    nativeHistory: false,
    servedTitles: [], acquireCalls: 0, witnessCalls: 0, allowed: true };
  // The provisioned genesis terminal-history row native mode requires
  // (explicit provisioning is maintenance-owned outside startup; the
  // world models it as already provisioned).
  const genesisBody = { schema: 'terminal-history-1', householdId,
    ledgerNamespace: exclusionDomain.ledgerNamespace, revision: 0, records: [] };
  const genesisDigest = C.digest(genesisBody);
  w.terminalRow = {
    historyBytes: Buffer.from(JSON.stringify({ ...genesisBody, digest: genesisDigest })),
    checkpointBytes: Buffer.from(JSON.stringify({
      schema: 'terminal-history-checkpoint-1', householdId,
      ledgerNamespace: exclusionDomain.ledgerNamespace,
      revision: 0, digest: genesisDigest })),
  };
  const fixture = require('./fixtures/savings-daily-consumer-data')();
  fixture.plan.savingsEarmarks.pools[0].goalRefs = [{ kind: 'commitment', id: 'near' }];
  w.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-host-suite-'));
  w.canonicalFile = path.join(w.dir, 'data.json');
  fs.writeFileSync(w.canonicalFile, JSON.stringify(fixture));
  w.base = JSON.parse(fs.readFileSync(w.canonicalFile, 'utf8'));
  const packet = clone(w.base.liveOverlay.currentPeriodActuals);
  packet.transactions = [{ id: 'synthetic-row', date: '2026-10-03', amount: 60, currency: 'cad', pending: false,
    categoryLabel: 'Groceries', merchantKnown: true, atlasAccountId: 'chequing-a', accountRole: 'household-cash',
    displayedPayee: 'Synthetic recorded payment' }];
  packet.transactionWindow = { startDate: '2026-10-02', endDate: '2026-10-05', complete: true, hasMore: false, truncated: false };
  w.acquisition = { packet, plan: clone(w.base.plan), join: [{ localId: 'synthetic-row',
    providerAccountId: 'SYNTHETIC-ACCOUNT', transactionId: 'SYNTHETIC-TRANSACTION' }],
    map: { mappings: [{ providerAccountId: 'SYNTHETIC-ACCOUNT', canonical: { id: 'chequing-a', collection: 'cash' } }] } };
  return w;
}

// Labelled provider/refresh DOUBLES, the composition suite's pattern:
// serve replays the context canonical; acquisition pairs the fixture
// packet with a witness bound to the issuing context revision.
function installDoubles(t, w) {
  const serve = Refresh.serve, acquire = Refresh.acquireSettlementWithWitness;
  Refresh.serve = async c => { w.servedTitles.push(c && c.meta ? c.meta.title : null); return clone(c); };
  Refresh.acquireSettlementWithWitness = async (c, e, o) => {
    w.acquireCalls++; assert.equal(typeof o.contextReader, 'function');
    const captured = clone(o.contextReader());
    assert.deepEqual(c, captured.canonical); assert.deepEqual(e, captured.env);
    return { acquisition: clone(w.acquisition), witness: () => { w.witnessCalls++;
      const cur = o.contextReader();
      return cur.contextRevision === captured.contextRevision && cur.domain === captured.domain; } };
  };
  const restore = () => { Refresh.serve = serve; Refresh.acquireSettlementWithWitness = acquire; };
  if (t) t.after(restore);
  return restore;
}

function request(w, urlPath, body, cookie = w.cookie) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(w.url + urlPath, { method: bytes ? 'POST' : 'GET', agent: false, headers: {
      ...(cookie ? { Cookie: cookie } : {}), ...(bytes ? { 'Content-Type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json',
        'Content-Length': bytes.length, Origin: 'https://atlas.example.test', 'X-Atlas-Settlement': 'same-origin', 'Sec-Fetch-Site': 'same-origin' } : {}) } }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', x => { raw += x; }); res.on('end', () => {
        let value; try { value = JSON.parse(raw); } catch { value = raw; } resolve({ status: res.statusCode, headers: res.headers, value }); });
    });
    req.setTimeout(5000, () => req.destroy(Error('synthetic request deadline'))); req.on('error', reject); req.end(bytes);
  });
}
async function login(w) {
  const r = await request(w, '/login', 'password=' + appEnv.SITE_PASSWORD, null);
  assert.equal(r.status, 302); return r.headers['set-cookie'][0].split(';')[0];
}
const sidOf = cookie => JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[0], 'base64url')).sid;
async function prepared(w, n = 1) {
  const catalogue = (await request(w, '/settlement/selections', {})).value;
  assert.equal(catalogue.status, 'available');
  const r = (await request(w, '/settlement/prepare', { operationId: op(n), selection: {
    transaction: catalogue.transactions[0].handle,
    commitment: catalogue.commitments.find(x => x.label.includes('first')).handle }, assignedCents: 2500 })).value;
  assert.equal(r.status, 'prepared'); assert.match(r.recoverySecret, /^[a-f0-9]{64}$/); return r;
}
const confirm = (w, p) => request(w, '/settlement/confirm',
  { operationId: p.operationId, previewToken: p.previewToken, generation: p.generation, confirmed: true });
const credential = p => ({ operationId: p.operationId, generation: p.generation, recoverySecret: p.recoverySecret });

// Maintenance bootstrap, the production pattern: genesis is written
// OUTSIDE startup by composing the shipped connection factory and the
// evidence store directly over the same custody — the server runtime
// deliberately exposes no bootstrap. Labelled synthetic world, same
// factories a maintenance tool composes.
async function bootstrapCustody(profile, custody, now) {
  const { createSettlementEvidencePostgresConnection } =
    require('../scripts/settlement-evidence-postgres-connection');
  const { createSettlementEvidenceStore } = require('../scripts/settlement-evidence-store');
  const owner = await createSettlementEvidencePostgresConnection(profile);
  try {
    const store = createSettlementEvidenceStore({ householdId,
      documentStore: owner.documentStore, journalStore: owner.journalStore,
      quarantine: owner.quarantine, lock: owner.lock,
      pinStore: custody.pinStore, backupStore: custody.backupStore,
      terminalHistory: custody.terminalHistory.mode === 'postgres'
        ? owner.terminalHistory : custody.terminalHistory,
      exclusionDomain: custody.exclusionDomain, now });
    assert.equal((await store.bootstrap()).status, 'bootstrapped');
  } finally { await owner.retire(); }
}

function hostConfig(w, overrides = {}) {
  return { ...appEnv,
    SETTLEMENT_FINANCIAL_DB_HOST: 'db.example.test', SETTLEMENT_FINANCIAL_DB_PORT: '5432',
    SETTLEMENT_FINANCIAL_DB_NAME: 'atlas', SETTLEMENT_FINANCIAL_DB_USER: FIN_USER,
    SETTLEMENT_FINANCIAL_DB_PASSWORD: canary, SETTLEMENT_FINANCIAL_DB_SCHEMA: 'settlement_financial',
    SETTLEMENT_FINANCIAL_DB_SCOPE: 'synthetic-scope',
    SETTLEMENT_AUTH_DB_HOST: 'db.example.test', SETTLEMENT_AUTH_DB_PORT: '5432',
    SETTLEMENT_AUTH_DB_NAME: 'atlas', SETTLEMENT_AUTH_DB_USER: AUTH_USER,
    SETTLEMENT_AUTH_DB_PASSWORD: canary, SETTLEMENT_AUTH_DB_SCHEMA: 'settlement_auth',
    SETTLEMENT_AUTH_DB_SCOPE: 'synthetic-scope',
    SETTLEMENT_HOUSEHOLD_ID: householdId, SETTLEMENT_ORIGIN: 'https://atlas.example.test',
    SETTLEMENT_CONTEXT_DOMAIN: 'synthetic-household-authority',
    SETTLEMENT_EXCLUSION_LEDGER_NAMESPACE: exclusionDomain.ledgerNamespace,
    SETTLEMENT_EXCLUSION_SERIALIZATION_AUTHORITY: exclusionDomain.serializationAuthority,
    SETTLEMENT_EXCLUSION_HISTORY_AUTHORITY: exclusionDomain.historyAuthority,
    canonicalFile: w.canonicalFile, ...overrides };
}
function custodyConfig(overrides = {}) {
  return {
    SETTLEMENT_CUSTODY_DB_HOST: 'db.example.test', SETTLEMENT_CUSTODY_DB_PORT: '5432',
    SETTLEMENT_CUSTODY_DB_NAME: 'atlas', SETTLEMENT_CUSTODY_DB_USER: CUSTODY_USER,
    SETTLEMENT_CUSTODY_DB_PASSWORD: canary, SETTLEMENT_CUSTODY_DB_SCHEMA: 'settlement_custody',
    SETTLEMENT_CUSTODY_DB_SCOPE: 'custody-scope', ...overrides };
}
const profileFor = user => ({ Client: SyntheticClient,
  config: { host: 'db.example.test', port: 5432, database: 'atlas', user, password: canary,
    ssl: { rejectUnauthorized: true, servername: 'db.example.test' } },
  schema: user === AUTH_USER ? 'settlement_auth' : 'settlement_financial', scope: 'synthetic-scope' });

// --- Host composition helpers shared with the A6 cold-process file ---
// Durable-custody host: the full production config shape (financial,
// authorization AND custody profiles), host.prepare() custody preflight,
// native terminal history — the same assembly server.js's require.main
// path composes, with only the labelled synthetic encrypt seam injected
// through the factory's existing `seams` parameter.
function durableConfig(w) { return { ...hostConfig(w), ...custodyConfig() }; }
async function composeHost(w, { bootstrap }) {
  const config = durableConfig(w);
  const host = createSettlementProductionHost(config, { encrypt: syntheticEncrypt });
  await host.prepare();
  if (bootstrap) {
    await bootstrapCustody({ ...host.settlement.connection,
      terminalHistory: { householdId, ledgerNamespace: exclusionDomain.ledgerNamespace } },
      host.settlement.custody, () => Date.now());
  }
  return { config, host };
}
async function listen(w, config, host) {
  const owner = await startServer({ env: config, host: '127.0.0.1', port: 0, settlement: host.settlement });
  w.owner = owner; w.url = 'http://127.0.0.1:' + owner.server.address().port; w.cookie = await login(w);
  return owner;
}
async function shutdown(owner, host) {
  if (owner) await owner.close().catch(() => {});
  if (host) { await host.retireCustody().catch(() => {}); host.close(); }
}
// Application writes observed at the synthetic backing: staged document
// promotions (the `WITH s AS` swap that publishes a new revision).
const docCommits = w => w.sql.filter(e => e.kind === 'financial' && e.text.startsWith('WITH s AS')).length;
const appWrites = (w, from = 0) => w.sql.slice(from).filter(e => e.kind !== 'custody'
  ? /^(INSERT|UPDATE|DELETE|WITH s AS)/.test(e.text) && !e.text.includes('auth_')
  : /^(INSERT|UPDATE)/.test(e.text));



// ---------------------------------------------------------------------
// Browser harness (Plan #6 A9 File 2). Same synthetic production-host
// world as File 1 above; the page is the real plan page served by the
// real startServer, driven in Chromium at 390px (Atlas ruling
// 6507359473 (d): HTTP/boot-only evidence cannot close the visible
// UI/retirement consumer path; no broader viewport matrix).
//
//   NODE_PATH=<Playwright packages> CHROME_PATH=<Chromium> \
//     node test/browser-a9-unknown-operation.js
// Optional: ATLAS_A9_BROWSER_PROOF=<path> writes the recorded rows.
//
// Frozen consumer states (ruling 6507359473):
//  S1 dispatched pending operation — Unknown is never presented as a
//     successful save / committed receipt / included publication; the
//     marker is retained, nothing installs through the failed
//     reconciliation, and the existing visible notice
//     ("Assignment outcome needs reconciliation. Figures remain
//     unavailable.") is the surface.
//  S2 ordinary no-marker view — qualified pinned evidence and its
//     independently justified Forecast results are preserved: a goal
//     fully paid by pinned facts still renders Paid and still retires
//     on schedule even though a separate operation query is Unknown.
//     The untainted control run must render identically.
//  S3 reversal-tainted payment evidence — no fabricated zero,
//     paid-green or retirement for the tainted goal; the unrelated
//     qualified assignment in the same document is preserved.
// Rows are recorded (not thrown at first failure); exit 1 if any FAIL.
const { chromium } = require('playwright');
const Forecast = require('../public/forecast');
const KEY = 'atlas-settlement-pending-v1';
const rows = [];
function record(id, name, ok, detail = {}) {
  rows.push({ id, name, result: ok ? 'PASS' : 'FAIL', ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}`);
}
function check(id, name, fn, detail = {}) {
  try { record(id, name, !!fn(), detail); } catch (e) { record(id, name, false, { ...detail, error: String(e && e.message || e) }); }
}

// Host composition without node:test: same started() shape as File 1.
// setup(w), when given, runs after makeWorld and before the server
// reads the canonical file, so a scenario can shape its fixture.
async function startedWorld(setup) {
  const w = makeWorld(); active = w; w.nativeHistory = true;
  if (setup) setup(w);
  const restore = installDoubles(null, w);
  const { config, host } = await composeHost(w, { bootstrap: true });
  const owner = await listen(w, config, host);
  w.host = host; w.config = config;
  return { w, restore, owner, host };
}
async function stopWorld({ w, restore, owner, host }) {
  restore();
  await shutdown(owner, host);
}
async function prepareFor(w, n, labelPart, cents) {
  const catalogue = (await request(w, '/settlement/selections', {})).value;
  assert.equal(catalogue.status, 'available');
  const r = (await request(w, '/settlement/prepare', { operationId: op(n), selection: {
    transaction: catalogue.transactions[0].handle,
    commitment: catalogue.commitments.find(x => x.label.includes(labelPart)).handle },
    assignedCents: cents })).value;
  assert.equal(r.status, 'prepared');
  assert.match(r.recoverySecret, /^[a-f0-9]{64}$/);
  return r;
}
const taintCheckpoint = w => {
  w.terminalRow = { ...w.terminalRow, checkpointBytes: Buffer.from('{"synthetic":"tainted-checkpoint"}') };
};
const outcomeOf = (w, p) => request(w, '/settlement/outcome', credential(p));

async function openPage(browser, w, { marker } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  const errors = [], external = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/settlement/')) requests.push({ method: request.method(), path: url.pathname });
  });
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== w.url) { external.push(new URL(route.request().url()).origin); return route.abort(); }
    return route.continue();
  });
  // Observing once-hook (the save-view suite's pattern): proves whether
  // any initial DATA ever reached the page's own once-hooks.
  await page.route('**/plan.js', async route => {
    try {
      const response = await route.fetch();
      await route.fulfill({ response, body: 'App.once(data => { window.__settlementOnce = (window.__settlementOnce || 0) + 1; });\n' + await response.text() });
    } catch (error) {
      if (!/disposed|closed|cancelled/i.test(error.message)) throw error;
    }
  });
  await page.goto(w.url + '/login');
  await page.getByLabel('Password', { exact: true }).fill(appEnv.SITE_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForFunction(() => typeof App !== 'undefined' && App.data !== null);
  if (marker) {
    await page.evaluate(({ KEY, marker }) => localStorage.setItem(KEY, JSON.stringify(marker)), { KEY, marker });
    await page.reload();
  }
  return { page, context, errors, external, requests };
}
// The tile face renders the club commitments as ONE group row
// ('group:club'); per-commitment paid blocks do not render separately
// for grouped goals in this fixture. The visible paid surface is the
// face's Paid line + the paid-progress block on the group row; the
// per-goal consumer facts are read through the same in-page Forecast
// calls plan.js renders from (savingsInventory / fundingSequence
// against App.data).
async function faceFacts(page) {
  const tile = page.locator('[data-budget-savings-goals]'); await tile.waitFor();
  const li = tile.locator('[data-budget-savings-goal="group:club"]');
  await li.waitFor({ state: 'attached' });
  // Clean main view (owner direction 2026-11-09): the visible goal row no
  // longer prints the Paid / Still-to-fund lines. They are read in the
  // row's tap-to-explain window, in the form the row used to print them
  // (screen-reader trust words removed, the ≈ mark kept). The visible row
  // paints after the base row; wait for it rather than racing it.
  const row = tile.locator('button.blend-goal-row[data-blend-goal="group:club"]');
  await row.waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
  const base = await li.evaluate(node => {
    const block = node.querySelector('[data-budget-goal-paid-progress]');
    return {
      blockState: block ? block.getAttribute('data-budget-goal-paid-progress') : null,
      blockPaid: node.querySelector('[data-budget-goal-paid]')?.textContent.trim() ?? null,
    };
  });
  let faces = { paid: null, stf: null };
  if (await row.count()) {
    await row.evaluate(node => node.click());
    const explain = page.locator('dialog[data-blend-explain][open]');
    await explain.waitFor({ timeout: 10000 });
    faces = await explain.evaluate(dialog => {
      const printed = (key, label) => {
        const dd = dialog.querySelector(`[data-blend-explain-fact="${key}"] dd:not(.blend-explain-note)`);
        if (!dd) return null;
        const copy = dd.cloneNode(true);
        copy.querySelectorAll('.budget-cash-sr').forEach(hidden => hidden.remove());
        return (label + ' ' + copy.textContent.replace(/\s+/g, ' ').trim()).trim();
      };
      return { paid: printed('paid', 'Paid'), stf: printed('still-to-fund', 'Still to fund') };
    });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog[data-blend-explain]')?.open);
  }
  return { ...base, paidFace: faces.paid, stfFace: faces.stf };
}
const consumerFacts = page => page.evaluate(() => {
  const d = App.data;
  const inv = Forecast.savingsInventory(d.plan, d.meta.asOf, { settlementEvidence: d.settlementEvidence });
  const goals = {};
  for (const g of inv.pools.flatMap(p => p.plannedGoals)) goals[g.key] =
    { paymentStatus: g.paymentStatus ?? null, linkedPaid: g.linkedPaid ?? null, remaining: g.remaining ?? null };
  const seq = Forecast.fundingSequence(d.plan, '2026-10-30', { settlementEvidence: d.settlementEvidence });
  const seqById = {};
  for (const r of seq) seqById[r.id] = { need: r.need ?? null };
  return { status: d.settlementEvidenceStatus?.status ?? null, goals, seqById };
});

// ------------------------------------------------------------ S1
async function scenarioS1(browser) {
  const id = 'S1-dispatched-unknown';
  const env1 = await startedWorld(); const { w } = env1;
  try {
    const p = await prepared(w);
    assert.equal((await confirm(w, p)).value.status, 'committed');
    taintCheckpoint(w);
    // The world really is in the Unknown state the page is about to meet.
    assert.deepEqual((await outcomeOf(w, p)).value, { status: 'unknown', operationId: p.operationId });
    const marker = { operationId: p.operationId, phase: 'dispatched',
      generation: p.generation, recoverySecret: p.recoverySecret };
    const { page, context, errors, external, requests } = await openPage(browser, w, { marker });
    await page.getByText('Assignment outcome needs reconciliation. Figures remain unavailable.', { exact: false }).waitFor();
    record(id, 'visible reconciliation/unavailable notice is the surface', true);
    const dataNull = await page.evaluate(() => App.data === null);
    const once = await page.evaluate(() => window.__settlementOnce || 0);
    const markerAfter = await page.evaluate(KEY => localStorage.getItem(KEY), KEY);
    check(id, 'App.data never installed', () => dataNull === true);
    check(id, 'no initial data reached the page once-hooks', () => once === 0, { once });
    check(id, 'pending marker retained byte-for-byte',
      () => markerAfter === JSON.stringify(marker));
    check(id, 'boot consulted the outcome route for the original operation',
      () => requests.some(r => r.path === '/settlement/outcome'));
    check(id, 'no publication was installed as a committed receipt',
      () => !requests.some(r => r.path === '/settlement/publication'));
    check(id, 'zero page errors', () => errors.length === 0, { errors });
    check(id, 'zero external requests', () => external.length === 0, { external });
    await context.close();
  } catch (e) {
    record(id, 'scenario completed', false, { error: String(e && e.stack || e).split('\n').slice(0, 3).join(' | ') });
  } finally { await stopWorld(env1); }
}

// ------------------------------------------------------------ S2
async function s2Run(browser, tainted) {
  const env2 = await startedWorld(); const { w } = env2;
  try {
    const p = await prepareFor(w, 2, 'first', 6000);
    assert.equal((await confirm(w, p)).value.status, 'committed');
    const before = (await request(w, '/data.json')).value;
    assert.deepEqual(before.settlementEvidenceStatus, { status: 'qualified' });
    if (tainted) {
      taintCheckpoint(w);
      assert.deepEqual((await outcomeOf(w, p)).value, { status: 'unknown', operationId: p.operationId },
        'the separate operation query is Unknown');
      const after = (await request(w, '/data.json')).value;
      assert.deepEqual(after.settlementEvidence, before.settlementEvidence,
        'pinned evidence unchanged by the checkpoint taint');
    }
    const { page, context, errors, external } = await openPage(browser, w, {});
    const facts = await consumerFacts(page);
    const face = await faceFacts(page);
    const evidenceInPage = await page.evaluate(() => App.data.settlementEvidence);
    await context.close();
    return { facts, face, evidenceInPage, before, errors, external };
  } finally { await stopWorld(env2); }
}
async function scenarioS2(browser) {
  const id = 'S2-pinned-facts-preserved';
  try {
    const tainted = await s2Run(browser, true);
    const near = tainted.facts.goals['commitment:near'];
    check(id, 'served status stays qualified under the taint', () => tainted.facts.status === 'qualified');
    check(id, 'page installed exactly the pinned evidence',
      () => JSON.stringify(tainted.evidenceInPage) === JSON.stringify(tainted.before.settlementEvidence));
    check(id, 'goal is Paid from the pinned facts (in-page Forecast consumer)',
      () => near?.paymentStatus === 'paid' && near?.linkedPaid === 60 && near?.remaining === 0,
      { near });
    check(id, 'the paid figure is consumer-visible on the tile face',
      () => tainted.face.paidFace === 'Paid $60.00' && tainted.face.blockPaid === '$60.00',
      { face: tainted.face });
    check(id, 'paid goal still retires on schedule (absent from the 2026-10-30 sequence)',
      () => !('near' in tainted.facts.seqById), { seqById: tainted.facts.seqById });
    check(id, 'zero page errors', () => tainted.errors.length === 0, { errors: tainted.errors });
    check(id, 'zero external requests', () => tainted.external.length === 0, { external: tainted.external });
    const control = await s2Run(browser, false);
    check(id, 'untainted control renders the identical consumer facts',
      () => JSON.stringify(control.facts) === JSON.stringify(tainted.facts)
        && JSON.stringify(control.face) === JSON.stringify(tainted.face),
      { controlNear: control.facts.goals['commitment:near'], taintedNear: near });
  } catch (e) {
    record(id, 'scenario completed', false, { error: String(e && e.stack || e).split('\n').slice(0, 3).join(' | ') });
  }
}

// ------------------------------------------------------------ S3
async function scenarioS3(browser) {
  const id = 'S3-reversal-tainted';
  // Both club commitments are pool goals in this scenario, so the
  // unrelated assignment's preservation is consumer-visible, not only
  // document-visible (File 1's world pools only 'near').
  const env3 = await startedWorld(w => {
    const data = JSON.parse(fs.readFileSync(w.canonicalFile, 'utf8'));
    data.plan.savingsEarmarks.pools[0].goalRefs =
      [{ kind: 'commitment', id: 'near' }, { kind: 'commitment', id: 'far' }];
    fs.writeFileSync(w.canonicalFile, JSON.stringify(data));
    w.base = data; w.acquisition.plan = clone(data.plan);
  });
  const { w } = env3;
  try {
    // Split the one recorded $60 payment: 3500 to 'near', 2500 to 'far'.
    const a = await prepareFor(w, 3, 'first', 3500);
    assert.equal((await confirm(w, a)).value.status, 'committed');
    const c = await prepareFor(w, 4, 'second', 2500);
    assert.equal((await confirm(w, c)).value.status, 'committed');
    // Retract the 'near' assignment through the shipped withdrawal path:
    // the document retains the history, effective relief is removed.
    const listed = (await request(w, '/settlement/assignments', {})).value;
    assert.equal(listed.assignments.length, 2);
    const target = listed.assignments.find(x => x.assignedCents === 3500);
    assert.ok(target && target.handle, 'the 3500-cent near assignment is listed');
    const wd = (await request(w, '/settlement/prepare-withdrawal',
      { operationId: op(9), assignmentHandle: target.handle })).value;
    assert.equal(wd.status, 'prepared');
    const wdConfirm = (await request(w, '/settlement/confirm',
      { operationId: op(9), previewToken: wd.previewToken, confirmed: true })).value;
    assert.equal(wdConfirm.status, 'committed');
    // Server-side consumer check on the served (effective) evidence.
    const served = (await request(w, '/data.json')).value;
    assert.deepEqual(served.settlementEvidenceStatus, { status: 'qualified' });
    const inv = Forecast.savingsInventory(served.plan, served.meta.asOf,
      { settlementEvidence: served.settlementEvidence });
    const goals = inv.pools.flatMap(p => p.plannedGoals);
    const near = goals.find(g => g.key === 'commitment:near');
    const far = goals.find(g => g.key === 'commitment:far');
    check(id, 'retracted goal has no paid relief in the served evidence',
      () => !!near && near.paymentStatus !== 'paid' && (near.linkedPaid ?? 0) === 0, { near });
    check(id, 'unrelated qualified assignment preserved in the same document',
      () => !!far && (far.linkedPaid ?? 0) === 25, { far });
    const { page, context, errors, external } = await openPage(browser, w, {});
    const facts = await consumerFacts(page);
    const face = await faceFacts(page);
    const nearF = facts.goals['commitment:near'];
    const farF = facts.goals['commitment:far'];
    check(id, 'tainted goal is not Paid in the page consumer facts',
      () => nearF?.paymentStatus !== 'paid' && (nearF?.linkedPaid ?? 0) === 0 && nearF?.remaining === 60,
      { near: nearF });
    check(id, 'tainted goal is not retired (still sequenced with its full $60 need)',
      () => facts.seqById.near?.need === 60, { seqById: facts.seqById });
    check(id, 'the retracted $35.00 is not presented as paid anywhere on the face',
      () => face.paidFace === 'Paid $25.00' && face.blockPaid === '$25.00',
      { face });
    check(id, 'unrelated goal keeps its qualified paid facts in the page',
      () => farF?.linkedPaid === 25 && farF?.remaining === 145, { far: farF });
    check(id, 'zero page errors', () => errors.length === 0, { errors });
    check(id, 'zero external requests', () => external.length === 0, { external });
    await context.close();
  } catch (e) {
    record(id, 'scenario completed', false, { error: String(e && e.stack || e).split('\n').slice(0, 3).join(' | ') });
  } finally { await stopWorld(env3); }
}

(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  try {
    await scenarioS1(browser);
    await scenarioS2(browser);
    await scenarioS3(browser);
    const pass = rows.filter(r => r.result === 'PASS').length;
    const fail = rows.filter(r => r.result === 'FAIL').length;
    console.log(`browser ${browser.version()} rows ${rows.length} pass ${pass} fail ${fail}`);
    if (process.env.ATLAS_A9_BROWSER_PROOF) fs.writeFileSync(process.env.ATLAS_A9_BROWSER_PROOF,
      JSON.stringify({ browser: browser.version(), rows }, null, 2));
    process.exitCode = fail ? 1 : 0;
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
