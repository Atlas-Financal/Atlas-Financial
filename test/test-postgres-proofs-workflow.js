'use strict';
/* The real-PostgreSQL proofs are never recorded as a pass without running.
 * `node test/test-postgres-proofs-workflow.js`
 *
 * test-private-period-history-postgres-local.js skips every test unless a
 * PostgreSQL bin directory is configured, and no required job configures one.
 * In the npm test manifest it therefore exited 0 and was recorded as a pass.
 * It now runs only in .github/workflows/postgres-proofs.yml. This suite proves:
 *   - the required manifest does not hold the two all-skip suites;
 *   - the shared fixture turns "unavailable" into an error under REQUIRED=1;
 *   - the workflow step clears TLS-trust variables (which would make the
 *     suites skip), refuses to run if any remain, requires the PostgreSQL
 *     tools, and runs each proof through the private CI output wrapper.
 * Synthetic environment and stub binaries only; no server is started here.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suites } = require('./test');
const { startLocalPg } = require('./fixtures/period-history-local-pg');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/postgres-proofs.yml'), 'utf8');
const PROOFS = ['test-private-period-history-postgres-local.js',
  'test-private-period-history-store-contract.js', 'test-period-history-refresh-capture.js'];
let failures = 0, checks = 0;
async function check(label, fn) {
  checks++;
  try { await fn(); console.log(`  PASS  ${label}`); }
  catch (error) { failures++; console.error(`  FAIL  ${label}: ${error.message}`); }
}

function runBlock(source) {
  const step = source.split('- name: Run the PostgreSQL proofs against a real local server')[1];
  assert(step, 'proof step present');
  return step.split('        run: |\n')[1].split('\n')
    .map(line => line.replace(/^          /, '')).join('\n');
}

// Run the shipped step with a stub `node` that records the environment it sees
// and stub PostgreSQL tools, so only the step's own shell logic is exercised.
function runStep(script, { tools = ['initdb', 'pg_ctl', 'postgres'], extraEnv = {}, failSuite = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-proofs-step-'));
  try {
    const bin = path.join(dir, 'bin'), pg = path.join(dir, 'pg');
    fs.mkdirSync(bin); fs.mkdirSync(pg);
    for (const tool of tools) fs.writeFileSync(path.join(pg, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'node'), [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$STUB_DIR/calls"',
      'env | cut -d= -f1 >> "$STUB_DIR/envs"',
      // A proof chosen by the caller fails, as a real failing suite would.
      'case "$*" in *"--identity $STUB_FAIL "*) exit 3 ;; esac',
      'exit 0',
    ].join('\n') + '\n', { mode: 0o755 });
    const env = { PATH: bin + path.delimiter + process.env.PATH, HOME: dir, STUB_DIR: dir,
      ATLAS_PERIOD_HISTORY_LOCAL_PG_BIN: pg, ATLAS_PERIOD_HISTORY_LOCAL_PG_REQUIRED: '1',
      STUB_FAIL: failSuite || 'none', ...extraEnv };
    const child = spawnSync('bash', ['-c', script], { cwd: ROOT, env, encoding: 'utf8' });
    const read = file => fs.existsSync(path.join(dir, file))
      ? fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').filter(Boolean) : [];
    return { status: child.status, calls: read('calls'), envs: read('envs') };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const TRUST = /^(?:PG.*|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|NODE_USE_SYSTEM_CA|SSL_CERT_FILE|SSL_CERT_DIR|OPENSSL_.*)$/i;
const POLLUTED = { PGHOST: 'x', pgpassfile: 'x', NODE_OPTIONS: '--use-openssl-ca', NODE_EXTRA_CA_CERTS: 'x',
  SSL_CERT_FILE: 'x', SSL_CERT_DIR: 'x', OPENSSL_CONF: 'x', NODE_TLS_REJECT_UNAUTHORIZED: '1', NODE_USE_SYSTEM_CA: '1' };

(async () => {
  await check('the required manifest holds neither all-skip suite, so it cannot record either as a pass', () => {
    const files = suites.map(([, file]) => file);
    for (const file of ['test-private-period-history-postgres-local.js', 'test-settlement-evidence-age-synthetic.js']) {
      assert(fs.existsSync(path.join(__dirname, file)), file + ' still exists');
      assert(!files.includes(file), file + ' must not be in the npm test manifest');
    }
  });

  await check('fixture: unavailable PostgreSQL is a skip by default and an error under REQUIRED=1', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-proofs-empty-'));
    try {
      assert.match((await startLocalPg({})).skip, /^UNRUN: /);
      assert.match((await startLocalPg({ ATLAS_PERIOD_HISTORY_LOCAL_PG_BIN: empty })).skip, /^UNRUN: initdb not found/);
      await assert.rejects(startLocalPg({ ATLAS_PERIOD_HISTORY_LOCAL_PG_REQUIRED: '1' }), /required but unavailable/);
      await assert.rejects(startLocalPg({ ATLAS_PERIOD_HISTORY_LOCAL_PG_REQUIRED: '1',
        ATLAS_PERIOD_HISTORY_LOCAL_PG_BIN: empty }), /required but unavailable: initdb not found/);
    } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  });

  await check('workflow: the step requires a real server and is not silently tolerated', () => {
    assert.match(WORKFLOW, /ATLAS_PERIOD_HISTORY_LOCAL_PG_REQUIRED: '1'/);
    assert.match(WORKFLOW, /ATLAS_PERIOD_HISTORY_LOCAL_PG_BIN: \/usr\/lib\/postgresql\/16\/bin/);
    assert.doesNotMatch(WORKFLOW, /continue-on-error/);
    assert.doesNotMatch(WORKFLOW, /\n    if:/, 'no job-level condition can skip the job');
    assert.doesNotMatch(WORKFLOW, /paths(-ignore)?:/, 'no path filter can skip the job on a pull request');
    const proofLines = runBlock(WORKFLOW).split('\n').filter(line => line.includes('ci-output.js'));
    assert.equal(proofLines.length, 1);
    assert.doesNotMatch(proofLines[0], /\|\||;|&/, 'no proof failure is swallowed');
  });

  await check('workflow step clears every TLS-trust variable and runs each proof through ci-output', () => {
    const run = runStep(runBlock(WORKFLOW), { extraEnv: POLLUTED });
    assert.equal(run.status, 0);
    assert.deepEqual(run.calls, PROOFS.map(suite => `scripts/ci-output.js --identity ${suite} -- node test/${suite}`));
    assert.deepEqual(run.envs.filter(key => TRUST.test(key)), []);
    assert(run.envs.includes('ATLAS_PERIOD_HISTORY_LOCAL_PG_REQUIRED'));
  });

  await check('workflow step fails when any proof fails, and runs no later proof', () => {
    for (const [index, suite] of PROOFS.entries()) {
      const run = runStep(runBlock(WORKFLOW), { failSuite: suite });
      assert.notEqual(run.status, 0, suite + ' failing must fail the step');
      assert.equal(run.calls.length, index + 1, suite);
    }
  });

  await check('workflow step fails before any proof when a PostgreSQL tool is missing', () => {
    const run = runStep(runBlock(WORKFLOW), { tools: ['initdb', 'pg_ctl'] });
    assert.notEqual(run.status, 0);
    assert.deepEqual(run.calls, []);
  });

  await check('mutation: without the clearing loop the guard refuses to run the proofs', () => {
    const script = runBlock(WORKFLOW).replace(/while IFS= read -r key; do unset "\$\{key\}"; done[^\n]*\n[^\n]*\n/, '');
    assert.notEqual(script, runBlock(WORKFLOW), 'mutation applied');
    const run = runStep(script, { extraEnv: POLLUTED });
    assert.notEqual(run.status, 0);
    assert.deepEqual(run.calls, []);
  });

  console.log(`\n${checks - failures}/${checks} postgres-proofs workflow checks passed.`);
  process.exitCode = failures ? 1 : 0;
})();
