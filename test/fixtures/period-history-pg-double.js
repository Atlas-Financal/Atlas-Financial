'use strict';
// Offline injected pg.Client double for the period-history profile. It models
// only the fixed statements the connection owner and the archive store emit:
// the four catalog preflight queries, BEGIN/COMMIT/ROLLBACK, the transaction
// advisory lock, SELECT of the archive and INSERT with a primary key on
// `sequence`. Unknown SQL fails. It is not a PostgreSQL parser or server, and
// cannot prove real TLS, privileges or durability; the local real-PostgreSQL
// test covers those where a server is available.
const { EventEmitter } = require('node:events');

const HOST = 'ep-invented-archive-000000.example.test';
const CANARY = 'PUBLIC-DUMMY-NOT-A-CREDENTIAL-CANARY';
const URL_VALUE = `postgresql://atlas_period_history_writer:${CANARY}@${HOST}/neondb?sslmode=verify-full`;

function catalog() {
  return {
    identity: { database: 'neondb', user: 'atlas_period_history_writer', pid: 4242, searchPath: 'pg_catalog' },
    role: { canLogin: true, superuser: false, createDb: false, createRole: false, inherit: false,
      replication: false, bypassRls: false, connectionLimit: 1, memberships: 0, ownedObjects: 0 },
    acl: new Set(['SELECT', 'INSERT']), columnAcl: new Set(),
    // capture_window_claims: absent by default (an archive set up before it).
    claimsAcl: null, claimsColumnAcl: new Set(),
    privileges: { connect: true, schemaUsage: true, databaseCreate: false, schemaCreate: false, tables: true, functions: true },
    schema: [{ name: 'revisions', kind: 'r', persistence: 'p', rls: false, forceRls: false, unsafe: false, primaryKeyCount: 1,
      columns: [['sequence', 'integer'], ['revision_id', 'text'], ['record', 'text']]
        .map(([name, type]) => ({ name, type, notNull: true, generated: '' })), primaryKey: ['sequence'] }],
  };
}

// The owner-approved claims table, shaped as the setup SQL creates it.
const CLAIMS_TABLE = Object.freeze({ name: 'capture_window_claims', kind: 'r', persistence: 'p', rls: false, forceRls: false, unsafe: false,
  primaryKeyCount: 1, columns: [['period_start', 'date'], ['period_end', 'date'], ['window_start', 'timestamp with time zone'],
    ['claimed_at', 'timestamp with time zone']].map(([name, type]) => ({ name, type, notNull: true, generated: '' })),
  primaryKey: ['window_start'] });
function withClaims(c, acl = ['INSERT']) {
  c.claimsAcl = new Set(acl);
  c.schema = [JSON.parse(JSON.stringify(CLAIMS_TABLE)), ...c.schema.filter(t => t.name !== 'capture_window_claims')];
  return c;
}
// The claims predicate as PostgreSQL would answer it: NULL when the table is
// absent (to_regclass), else INSERT and none of the forbidden grants tested.
const CLAIMS = "to_regclass(format('%I.%I',$1,'capture_window_claims'))";
function claimsFrom(text, c) {
  if (!c.claimsAcl) return null;
  if (!text.includes(`has_table_privilege(${CLAIMS},'INSERT')`) || !c.claimsAcl.has('INSERT')) return false;
  for (const p of ['SELECT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER'])
    if (c.claimsAcl.has(p) && text.includes(`NOT has_table_privilege(${CLAIMS},'${p}')`)) return false;
  for (const p of ['SELECT', 'UPDATE', 'REFERENCES'])
    if (c.claimsColumnAcl.has(p) && text.includes(`NOT has_any_column_privilege(${CLAIMS},'${p}')`)) return false;
  return true;
}
// Effective grants on the archive table, evaluated against the predicates the
// emitted privilege query actually contains: a grant the query does not test
// for is reported as safe, exactly as PostgreSQL would answer that query.
const ARCHIVE = "format('%I.%I',$1,'revisions')";
function tablesFrom(text, c) {
  let ok = ['SELECT', 'INSERT'].every(p => c.acl.has(p) && text.includes(`has_table_privilege(${ARCHIVE},'${p}')`));
  for (const p of ['UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER'])
    if (c.acl.has(p) && text.includes(`NOT has_table_privilege(${ARCHIVE},'${p}')`)) ok = false;
  for (const p of ['UPDATE', 'REFERENCES'])
    if (c.columnAcl.has(p) && text.includes(`NOT has_any_column_privilege(${ARCHIVE},'${p}')`)) ok = false;
  return ok;
}
function pgWorld(options = {}) {
  const w = { committed: [], queries: [], constructed: 0, ends: 0, config: null, catalog: catalog(), fail: options.fail || null };
  class Client extends EventEmitter {
    constructor(config) {
      super(); w.constructed++; w.config = config; (w.clients ||= []).push(this);
      this.pending = null; this.seen = 0;
      this.connection = { stream: { encrypted: true, authorized: true, servername: HOST,
        getPeerCertificate: () => ({ subjectaltname: 'DNS:' + HOST }) } };
    }
    async connect() { if (options.connect) await options.connect(); }
    async end() { w.ends++; this.emit('end'); }
    async query(text, values = []) {
      const index = this.seen++; w.queries.push({ text, values });
      if (w.fail) { const r = w.fail({ text, values, index, w }); if (r) throw r; }
      if (index === 0) return { command: 'SELECT', rows: [w.catalog.identity] };
      if (index === 1) return { command: 'SELECT', rows: [w.catalog.role] };
      if (index === 2) {
        if (!/pg_try_advisory_xact_lock\(integer,integer\)/.test(text) || !/'revisions'/.test(text)) throw Object.assign(new Error('unmodelled'), { code: 'XX000' });
        return { command: 'SELECT', rows: [{ ...w.catalog.privileges, tables: w.catalog.privileges.tables && tablesFrom(text, w.catalog),
          claims: claimsFrom(text, w.catalog) }] };
      }
      if (index === 3) {
        if (/conenforced/.test(text) || !/LIMIT 3/.test(text)) throw Object.assign(new Error('unmodelled'), { code: '42703' });
        return { command: 'SELECT', rows: w.catalog.schema };
      }
      if (text === 'BEGIN') { this.pending = []; return { command: 'BEGIN', rows: [] }; }
      if (text === 'ROLLBACK') { this.pending = null; return { command: 'ROLLBACK', rows: [] }; }
      if (text === 'COMMIT') { w.committed.push(...(this.pending || [])); this.pending = null; return { command: 'COMMIT', rows: [] }; }
      if (/^SELECT pg_catalog\.pg_try_advisory_xact_lock\(\$1::integer, \$2::integer\) AS locked$/.test(text))
        return { command: 'SELECT', rows: [{ locked: options.locked !== false }] };
      if (/^SELECT sequence, revision_id, record FROM "[a-z_]+"\.revisions ORDER BY sequence$/.test(text))
        return { command: 'SELECT', rows: w.committed.map(row => ({ ...row })).sort((a, b) => a.sequence - b.sequence) };
      if (/^INSERT INTO "[a-z_]+"\.revisions \(sequence, revision_id, record\) VALUES \(\$1, \$2, \$3\)$/.test(text)) {
        const [sequence, revision_id, record] = values;
        if (!this.pending) throw Object.assign(new Error('no transaction'), { code: '25P01' });
        if (w.committed.some(row => row.sequence === sequence)) throw Object.assign(new Error(CANARY), { code: '23505' });
        this.pending.push({ sequence, revision_id, record });
        return { command: 'INSERT', rows: [], rowCount: 1 };
      }
      if (/^INSERT INTO "[a-z_]+"\.capture_window_claims \(period_start, period_end, window_start\) VALUES \(\$1, \$2, \$3\) ON CONFLICT DO NOTHING$/.test(text)) {
        if (!w.catalog.claimsAcl || !w.catalog.claimsAcl.has('INSERT')) throw Object.assign(new Error(CANARY), { code: '42501' });
        const key = values[2]; // PRIMARY KEY (window_start)
        w.claims ||= new Set();
        if (w.claims.has(key)) return { command: 'INSERT', rows: [], rowCount: 0 };
        w.claims.add(key); return { command: 'INSERT', rows: [], rowCount: 1 };
      }
      throw Object.assign(new Error('unmodelled ' + CANARY), { code: 'XX000' });
    }
  }
  w.Client = Client;
  return w;
}
module.exports = { HOST, CANARY, URL_VALUE, pgWorld, catalog, withClaims };
