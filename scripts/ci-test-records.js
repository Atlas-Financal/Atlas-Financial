'use strict';
/* Independent bootstrap sink: do not load runner/launcher/capture modules.
 * Keep every incoming byte private; reconstruct only the closed public schema. */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const group = process.argv[2];
const categories = ['none', 'capture-failed', 'invalid-configuration', 'missing-suite',
  'spawn-failed', 'signal-terminated', 'unsupported-platform', 'storage-failed',
  'assertion-failed', 'process-failed', 'private-artifact-blocked', 'invalid-record'];
const signals = ['SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGHUP', 'SIGINT', 'SIGKILL',
  'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGTERM'];
const identities = new Set(), outcomes = new Map();
const installGroup = group === 'install-runtime' || group === 'install-test';
const id = value => installGroup ? value === group
  : typeof value === 'string' && /^(test|probe)-[a-z0-9-]+\.js$/.test(value)
    && fs.existsSync(path.join(__dirname, '..', 'test', value));
const number = value => Number.isSafeInteger(value) && value >= 0;
let invalid = false, finished = false, summary = null, terminal = null, active = null, fd;
// A failure cannot describe success, and a signal cannot also be an exit code.
const coherent = r => r.status === 'pass'
  ? r.category === 'none' && r.exitCode === 0 && r.signal === null
  : r.category !== 'none' && r.exitCode !== 0 && (r.signal === null
    ? r.category !== 'signal-terminated'
    : r.category === 'signal-terminated' && r.exitCode === null);
function emit(record) { fs.writeSync(1, JSON.stringify(record) + '\n'); }
try {
  if (!['standard', 'refresh-isolation', 'install-runtime', 'install-test'].includes(group) || !process.env.ATLAS_CI_BOOTSTRAP_DIR)
    throw new Error('invalid-configuration');
  fd = fs.openSync(path.join(process.env.ATLAS_CI_BOOTSTRAP_DIR, 'bootstrap.stdout.log'), 'w', 0o600);
  process.stdin.on('data', chunk => { try { fs.writeSync(fd, chunk); } catch { invalid = true; } });
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => {
    try {
      if (finished || line.length > 65536) throw new Error('invalid-record');
      const r = JSON.parse(line);
      if (r.type === 'ci-suite-start' && !installGroup && !summary && active === null
          && id(r.identity) && !identities.has(r.identity) && !outcomes.has(r.identity)) {
        active = r.identity; identities.add(r.identity); emit({ type: r.type, identity: r.identity });
      } else if (r.type === 'ci-outcome' && !summary && id(r.identity) && !outcomes.has(r.identity)
          && ['pass', 'fail'].includes(r.status) && categories.includes(r.category)
          && (r.exitCode === null || (number(r.exitCode) && r.exitCode <= 255))
          && (r.signal === null || signals.includes(r.signal)) && typeof r.executed === 'boolean'
          && (!r.executed || installGroup || identities.has(r.identity)) && r.counts && r.counts.total === 1
          && r.counts.passed === (r.status === 'pass' ? 1 : 0) && r.counts.failed === (r.status === 'fail' ? 1 : 0)
          && coherent(r) && (r.status !== 'pass' || r.executed)
          && (r.signal === null || r.executed)
          && (active === null || active === r.identity)) {
        if (active === r.identity) active = null;
        outcomes.set(r.identity, r.status);
        const vetted = { type: r.type, identity: r.identity, status: r.status, category: r.category,
          exitCode: r.exitCode, signal: r.signal, executed: r.executed,
          counts: { total: 1, passed: r.counts.passed, failed: r.counts.failed } };
        if (r.status === 'pass' && r.identity === 'test-ci-output.js'
            && r.syntheticProof === 'stdout-stderr-annotations-formatter-and-exit-canaries') vetted.syntheticProof = r.syntheticProof;
        emit(vetted);
      } else if (r.type === 'ci-suite-summary' && !installGroup && !summary && number(r.total) && r.total > 0
          && number(r.passed) && number(r.failed) && r.total === outcomes.size && r.passed + r.failed === r.total
          && Array.isArray(r.failedSuites) && r.exitCode === (r.failed ? 1 : 0)) {
        const failed = [...outcomes].filter(([, status]) => status === 'fail').map(([identity]) => identity);
        if (r.failed !== failed.length || JSON.stringify(failed) !== JSON.stringify(r.failedSuites)
            || active !== null || [...identities].some(identity => !outcomes.has(identity))
            || ('status' in r && r.status !== (r.failed ? 'fail' : 'pass'))) throw new Error('invalid-record');
        summary = { total: r.total, passed: r.passed, failed: r.failed, exitCode: r.exitCode };
        emit({ type: r.type, total: r.total, passed: r.passed, failed: r.failed,
          failedSuites: failed, exitCode: r.exitCode });
      } else if (r.type === 'ci-worker-outcome' && r.identity === group && ['pass', 'fail'].includes(r.status)
          && categories.includes(r.category) && (r.exitCode === null || (number(r.exitCode) && r.exitCode <= 255))
          && (r.signal === null || signals.includes(r.signal))
          && coherent(r) && (r.status !== 'pass' || (!invalid && active === null
            && outcomes.size > 0 && [...outcomes.values()].every(status => status === 'pass')
            && (installGroup ? outcomes.size === 1 && outcomes.get(group) === 'pass'
              : summary && summary.failed === 0 && summary.exitCode === 0 && summary.passed === summary.total)))) {
        finished = true;
        terminal = { type: r.type, identity: group, status: r.status, category: r.category,
          exitCode: r.exitCode, signal: r.signal };
      } else throw new Error('invalid-record');
    } catch { invalid = true; }
  });
  lines.on('close', () => {
    try { fs.closeSync(fd); } catch { invalid = true; }
    // Wait for EOF and private storage close before publishing terminal success.
    // A duplicate/trailing record or a failed terminal always stays red.
    if (invalid || !finished) emit({ type: 'ci-worker-outcome', identity: group,
      status: 'fail', category: 'invalid-record', exitCode: 1, signal: null });
    else emit(terminal);
    process.exitCode = invalid || !finished || terminal.status !== 'pass' ? 1 : 0;
  });
} catch { process.exitCode = 1; }
