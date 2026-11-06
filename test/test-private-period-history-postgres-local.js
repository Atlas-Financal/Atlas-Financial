'use strict';
// Real local PostgreSQL proof for the hosted period-history backend. Runs only
// when ATLAS_PERIOD_HISTORY_LOCAL_PG_BIN names a PostgreSQL bin directory;
// otherwise every test is SKIPPED (UNRUN, never PASS). Invented data only.
//   L1 the owner setup SQL in the doc yields a catalog the shared owner accepts
//   L2 PostgreSQL itself refuses UPDATE, DELETE, TRUNCATE and DDL by the writer
//   L3 revisions survive a server restart with every hash intact
//   L4 wrong password, untrusted CA, missing schema and a second session fail
//      closed with only a stage/category/SQLSTATE diagnostic
const test = require('node:test');
const assert = require('node:assert/strict');
const History = require('../scripts/private-period-history');
const Pg = require('../scripts/private-period-history-postgres');
const { startLocalPg, HOST } = require('./fixtures/period-history-local-pg');
const { NEXT, input, capture } = require('./fixtures/private-period-history-input');

const trustClean = !Object.keys(process.env).some(k => /^(?:PG.*|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|NODE_USE_SYSTEM_CA|SSL_CERT_FILE|SSL_CERT_DIR|OPENSSL_.*)$/i.test(k));
let local = null, skip = 'not started';
test.before(async () => {
  if (!trustClean) { skip = 'UNRUN: TLS-trust variables present'; return; }
  const started = await startLocalPg();
  if (started.skip) skip = started.skip; else { local = started; skip = false; }
});
test.after(() => { if (local) local.stop(); });
const open = (extra = {}) => Pg.openPeriodHistoryPostgres({ env: { [Pg.ENV_NAME]: local.url }, Client: local.LocalClient, ...extra });
const unavailable = (category, code) => e => e.code === 'history-store-unavailable' && e.diagnostic?.category === category
  && (code === undefined || e.diagnostic.code === code) && !JSON.stringify(e).includes(local.password) && !String(e.message).includes(HOST);

test('L1-L3 owner SQL, database-enforced append-only, restart persistence', async t => {
  if (skip) return t.skip(skip);
  await local.admin('TRUNCATE atlas_period_history.revisions');
  let store = await open();
  const a = await store.append({ enabled: true, candidate: capture(input()) });
  const b = await store.append({ enabled: true, candidate: capture(input({ day: NEXT, kind: 'closing' })) });
  await store.retire();

  // L2: the writer role, connected directly, cannot rewrite or restructure history.
  const raw = new local.LocalClient({ host: HOST, port: local.port, database: 'neondb', user: 'atlas_period_history_writer',
    password: local.password, ssl: { rejectUnauthorized: true, servername: HOST } });
  await raw.connect();
  try {
    for (const sql of [
      "UPDATE atlas_period_history.revisions SET record = record || ' '",
      'DELETE FROM atlas_period_history.revisions',
      'TRUNCATE atlas_period_history.revisions',
      'CREATE TABLE atlas_period_history.extra (x int)',
      'ALTER TABLE atlas_period_history.revisions ADD COLUMN x int',
      'CREATE TRIGGER t BEFORE INSERT ON atlas_period_history.revisions FOR EACH ROW EXECUTE FUNCTION pg_catalog.suppress_redundant_updates_trigger()',
    ]) await assert.rejects(raw.query(sql), e => e.code === '42501', 'refused: ' + sql.split(' ').slice(0, 2).join(' '));
  } finally { await raw.end(); }

  // L3: a full server restart; a fresh session reads the same verified chain.
  local.restart();
  store = await open();
  const list = await store.read({ expectedHead: b.revisionId });
  assert.deepEqual(list.map(r => r.revisionId), [a.revisionId, b.revisionId]);
  for (const meta of list) {
    const { revisionId, ...body } = await store.read({ revisionId: meta.revisionId });
    assert.equal(History.contract.digest(body), revisionId);
  }
  await store.retire();
});

test('L4 real failures stay closed and code-only', async t => {
  if (skip) return t.skip(skip);
  await assert.rejects(Pg.openPeriodHistoryPostgres({ env: { [Pg.ENV_NAME]: local.url.replace(local.password, 'x' + local.password) },
    Client: local.LocalClient }), unavailable('authentication', '28P01'));
  await assert.rejects(open({ Client: local.UntrustedClient }), unavailable('tls'));
  await assert.rejects(open({ schema: 'absent_schema' }), e => e.code === 'history-store-unavailable' && e.diagnostic?.stage === 'privileges' && ['sql', 'other'].includes(e.diagnostic?.category));
  // CONNECTION LIMIT 1: a second concurrent writer session is refused by PostgreSQL.
  const first = await open();
  await assert.rejects(open(), unavailable('sql', '53300'));
  await first.retire();
});
