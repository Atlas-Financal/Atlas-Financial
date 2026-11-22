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
let suiteNames;
const id = value => installGroup ? value === group
  : suiteNames.has(value);
const number = value => Number.isSafeInteger(value) && value >= 0;
let invalid = false, finished = false, summary = null, terminal = null, active = null, lastBeat = 0, fd;
// A failure cannot describe success, and a signal cannot also be an exit code.
const coherent = r => r.status === 'pass'
  ? r.category === 'none' && r.exitCode === 0 && r.signal === null
  : r.category !== 'none' && r.exitCode !== 0 && (r.signal === null
    ? r.category !== 'signal-terminated'
    : r.category === 'signal-terminated' && r.exitCode === null);
function emit(record) { fs.writeSync(1, JSON.stringify(record) + '\n'); }
// Failing subtest names: re-checked here, independently of the capture
// module, by the same rule. A name is kept only when it is a literal
// substring of the suite's committed source, has at most 80 characters from
// letters, digits, space and _ . : ( ) / -, and holds no amount-, date- or
// time-like digits. Any other entry becomes '[redacted]'.
function subtestNames(identity, names) {
  if (installGroup || !Array.isArray(names) || names.length < 1 || names.length > 10) throw new Error('invalid-record');
  let source = null;
  try { source = fs.readFileSync(path.join(__dirname, '..', 'test', identity), 'utf8'); } catch { /* Redact all. */ }
  return names.map(name => typeof name === 'string' && source !== null && name.length >= 1 && name.length <= 80
    && name.trim() === name && /^[A-Za-z0-9 _.:()/-]+$/.test(name) && !/[0-9]{3}|\.[0-9]|[0-9]:[0-9]/.test(name)
    && source.includes(name) ? name : '[redacted]');
}
try {
  if (!['standard', 'refresh-isolation', 'install-runtime', 'install-test'].includes(group) || !process.env.ATLAS_CI_BOOTSTRAP_DIR)
    throw new Error('invalid-configuration');
  if (!installGroup) {
    // Read the runner's single inert manifest, never execute runner code or
    // promote arbitrary filenames found on disk into public suite identities.
    const source = fs.readFileSync(path.join(__dirname, '..', 'test', 'suites.json'), 'utf8');
    if (source.length > 1048576) throw new Error('invalid-configuration');
    const manifest = JSON.parse(source);
    suiteNames = new Set();
    if (!Array.isArray(manifest) || !manifest.length) throw new Error('invalid-configuration');
    for (const row of manifest) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !row[0].trim()
          || typeof row[1] !== 'string' || row[1].length > 180
          || !/^(test|probe)-[a-z0-9-]+\.js$/.test(row[1]) || suiteNames.has(row[1]))
        throw new Error('invalid-configuration');
      suiteNames.add(row[1]);
    }
    if (!suiteNames.has('test-refresh-isolation.js')
        || [...suiteNames].join(', ').length > 60000) throw new Error('invalid-configuration');
    suiteNames = new Set([...suiteNames].filter(name => group === 'refresh-isolation'
      ? name === 'test-refresh-isolation.js' : name !== 'test-refresh-isolation.js'));
  }
  fd = fs.openSync(path.join(process.env.ATLAS_CI_BOOTSTRAP_DIR, 'bootstrap.stdout.log'), 'w', 0o600);
  process.stdin.on('data', chunk => { try { fs.writeSync(fd, chunk); } catch { invalid = true; } });
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => {
    try {
      if (finished || line.length > 65536) throw new Error('invalid-record');
      const r = JSON.parse(line);
      if (r.type === 'ci-suite-start' && !installGroup && !summary && active === null
          && id(r.identity) && !identities.has(r.identity) && !outcomes.has(r.identity)) {
        active = r.identity; lastBeat = 0; identities.add(r.identity); emit({ type: r.type, identity: r.identity });
      } else if (r.type === 'ci-suite-heartbeat' && !installGroup && !summary && active !== null
          && r.identity === active && Number.isSafeInteger(r.elapsedSeconds) && r.elapsedSeconds >= 1
          && r.elapsedSeconds <= 86400 && r.elapsedSeconds > (lastBeat || 0)) {
        // Content-free progress for the running suite: rebuilt from its
        // identity and whole seconds only; any other field is dropped.
        lastBeat = r.elapsedSeconds;
        emit({ type: r.type, identity: r.identity, elapsedSeconds: r.elapsedSeconds });
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
        if (r.failedSubtests !== undefined) {
          if (r.status !== 'fail') throw new Error('invalid-record');
          vetted.failedSubtests = subtestNames(r.identity, r.failedSubtests);
        }
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
    else {
      if (summary && summary.failed && terminal.status === 'fail') {
        // One GitHub workflow annotation, only after the entire protocol and
        // private storage close succeeded. Its message contains manifest-owned
        // filenames only; child text and descriptive labels never enter it.
        const failed = [...outcomes].filter(([, status]) => status === 'fail').map(([name]) => name);
        fs.writeSync(1, '::error title=Failed suites::' + failed.join(', ') + '\n');
      }
      emit(terminal);
    }
    process.exitCode = invalid || !finished || terminal.status !== 'pass' ? 1 : 0;
  });
} catch { process.exitCode = 1; }
