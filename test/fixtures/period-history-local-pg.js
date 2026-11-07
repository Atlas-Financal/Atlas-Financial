'use strict';
// Disposable local PostgreSQL for the period-history backend, used only when
// ATLAS_PERIOD_HISTORY_LOCAL_PG_BIN names a directory holding initdb, pg_ctl
// and postgres (for example /usr/lib/postgresql/16/bin). Otherwise callers
// SKIP; a skip is recorded as not run, never as a pass.
//
// It builds the archive with the OWNER SETUP SQL copied verbatim from
// docs/PRIVATE_PERIOD_HISTORY.md, then serves it over real TLS with a
// throwaway private CA for the invented host pg.atlas-history.test. The test
// Client keeps verify-full (rejectUnauthorized + hostname) and only adds that
// CA and the loopback address; production uses Node's built-in roots.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');

const HOST = 'pg.atlas-history.test';
const DOC = path.join(__dirname, '..', '..', 'docs', 'PRIVATE_PERIOD_HISTORY.md');
const PLACEHOLDER = 'CHANGE_ME_LONG_RANDOM_PASSWORD';

function setupSql() {
  const doc = fs.readFileSync(DOC, 'utf8');
  const match = doc.match(/<!-- period-history-setup-sql:start -->\n```sql\n([\s\S]*?)```\n<!-- period-history-setup-sql:end -->/);
  if (!match) throw new Error('owner setup SQL block missing from docs/PRIVATE_PERIOD_HISTORY.md');
  return match[1];
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
    server.on('error', reject);
  });
}

async function startLocalPg() {
  const bin = process.env.ATLAS_PERIOD_HISTORY_LOCAL_PG_BIN;
  if (!bin) return { skip: 'UNRUN: set ATLAS_PERIOD_HISTORY_LOCAL_PG_BIN to a PostgreSQL bin directory to run against a real server' };
  for (const tool of ['initdb', 'pg_ctl', 'postgres']) if (!fs.existsSync(path.join(bin, tool))) return { skip: 'UNRUN: ' + tool + ' not found' };
  const pg = require('pg');
  const runAs = process.getuid && process.getuid() === 0 ? (process.env.ATLAS_PERIOD_HISTORY_LOCAL_PG_USER || 'postgres') : null;
  const run = (cmd, args, opts = {}) => execFileSync(runAs ? 'runuser' : cmd, runAs ? ['-u', runAs, '--', cmd, ...args] : args,
    { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-history-pg-'));
  fs.chmodSync(dir, 0o755);
  const data = path.join(dir, 'data'), sock = path.join(dir, 'sock'), certs = path.join(dir, 'certs');
  fs.mkdirSync(sock); fs.mkdirSync(certs);
  const ssl = (...args) => execFileSync('openssl', args, { cwd: certs, stdio: ['ignore', 'pipe', 'pipe'] });
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/CN=atlas-history-test-ca');
  ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=' + HOST);
  fs.writeFileSync(path.join(certs, 'ext.cnf'), 'subjectAltName=DNS:' + HOST + '\n');
  ssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '2', '-extfile', 'ext.cnf');
  fs.chmodSync(path.join(certs, 'server.key'), 0o600);
  if (runAs) execFileSync('chown', ['-R', runAs, dir]);
  run(path.join(bin, 'initdb'), ['-D', data, '-U', 'atlas_admin', '--auth-local=trust', '--auth-host=scram-sha-256', '-E', 'UTF8']);
  // Loopback TCP only over TLS with a password; the admin uses the private socket.
  fs.writeFileSync(path.join(data, 'pg_hba.conf'), 'local all all trust\nhostssl all all 127.0.0.1/32 scram-sha-256\n');
  if (runAs) execFileSync('chown', [runAs, path.join(data, 'pg_hba.conf')]);
  const port = await freePort();
  const options = ['-c port=' + port, '-c listen_addresses=127.0.0.1', '-c unix_socket_directories=' + sock, '-c ssl=on',
    '-c ssl_cert_file=' + path.join(certs, 'server.crt'), '-c ssl_key_file=' + path.join(certs, 'server.key')].join(' ');
  const ctl = action => run(path.join(bin, 'pg_ctl'), ['-D', data, '-l', path.join(dir, 'log'), '-w', '-o', options, action]);
  ctl('start');
  const ca = fs.readFileSync(path.join(certs, 'ca.crt'));
  async function admin(sql, values, database = 'neondb') {
    const client = new pg.Client({ host: sock, port, user: 'atlas_admin', database });
    await client.connect();
    try { return await client.query(sql, values); } finally { await client.end(); }
  }
  await admin('CREATE DATABASE neondb', [], 'postgres');
  // A long random alphanumeric password, as the owner steps ask for.
  const password = require('node:crypto').randomBytes(24).toString('hex');
  const sql = setupSql();
  if (!sql.includes(PLACEHOLDER)) throw new Error('setup SQL lost its password placeholder');
  await admin(sql.replace(PLACEHOLDER, password));
  class LocalClient extends pg.Client {
    constructor(config) { super({ ...config, host: '127.0.0.1', ssl: { ...config.ssl, ca } }); }
  }
  class UntrustedClient extends pg.Client { // Node's default roots only: the private CA must be refused
    constructor(config) { super({ ...config, host: '127.0.0.1' }); }
  }
  return {
    url: `postgresql://atlas_period_history_writer:${password}@${HOST}:${port}/neondb?sslmode=verify-full`,
    password, port, LocalClient, UntrustedClient, admin,
    restart: () => { ctl('stop'); ctl('start'); },
    stop: () => { try { ctl('stop'); } finally { fs.rmSync(dir, { recursive: true, force: true }); } },
  };
}
module.exports = { startLocalPg, setupSql, HOST, PLACEHOLDER };
