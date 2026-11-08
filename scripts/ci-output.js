'use strict';
/* Public CI reports identities and outcomes, never child diagnostics.
 * The synchronous command runs once. Both output streams and runner file
 * channels stay in unuploaded, owner-only temporary files. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const COMMAND_IDS = new Set(['figures-base-checkout', 'figures-head-snapshot', 'figures-base-snapshot',
  'figures-comment', 'cursor-repair', 'cursor-models', 'repair-tests', 'install-runtime',
  'privacy-guard', 'risk-label-gate', 'codex-review-gate', 'atlas-test-repair-gate', 'acceptance-scoreboard']);
const SUITE_FILE = /^(?:test|probe)-[a-z0-9-]+\.js$/;
const SIGNALS = new Set(['SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGHUP', 'SIGINT',
  'SIGKILL', 'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGTERM']);
const CATEGORIES = new Set(['none', 'capture-failed', 'invalid-configuration', 'missing-suite',
  'spawn-failed', 'signal-terminated', 'unsupported-platform', 'storage-failed',
  'assertion-failed', 'process-failed', 'private-artifact-blocked']);
function publicMode(env = process.env) {
  return env.GITHUB_ACTIONS === 'true' || env.ATLAS_PUBLIC_CI === '1';
}
function validIdentity(id) {
  return COMMAND_IDS.has(id) || (typeof id === 'string' && SUITE_FILE.test(id)
    && fs.existsSync(path.join(__dirname, '..', 'test', id)));
}
function suiteIdentity(id, ordinal) {
  return typeof id === 'string' && SUITE_FILE.test(id) ? id : 'suite-' + ordinal;
}
function publish(result) {
  if (!(COMMAND_IDS.has(result.identity) || result.identity === 'ci-command'
      || SUITE_FILE.test(result.identity) || /^suite-[1-9][0-9]*$/.test(result.identity))
      || !['pass', 'fail'].includes(result.status) || !CATEGORIES.has(result.category)
      || !(result.exitCode === null || Number.isInteger(result.exitCode))
      || !(result.signal === null || SIGNALS.has(result.signal))
      || typeof result.executed !== 'boolean') throw new Error('invalid-ci-outcome');
  const record = { type: 'ci-outcome', identity: result.identity,
    status: result.status, category: result.category, exitCode: result.exitCode,
    signal: result.signal, executed: result.executed,
    counts: { total: 1, passed: result.status === 'pass' ? 1 : 0,
      failed: result.status === 'pass' ? 0 : 1 } };
  if (result.status === 'pass' && result.syntheticProofVerified)
    record.syntheticProof = 'stdout-stderr-annotations-formatter-and-exit-canaries';
  fs.writeSync(1, JSON.stringify(record) + '\n');
}
function startSuite(identity) {
  if (!validIdentity(identity)) throw new Error('invalid-ci-identity');
  fs.writeSync(1, JSON.stringify({ type: 'ci-suite-start', identity }) + '\n');
}
function categoryFor(error, stderrFile, identity) {
  if (error.signal) return 'signal-terminated';
  if (error.status == null) return 'spawn-failed';
  if (error.status === 78 && ['codex-review-gate', 'atlas-test-repair-gate'].includes(identity))
    return 'private-artifact-blocked';
  let text = '';
  try { text = fs.readFileSync(stderrFile, 'utf8'); } catch { /* Never echo read errors. */ }
  if (/posix-durable-store-required/.test(text)) return 'unsupported-platform';
  if (/history-io-failed/.test(text)) return 'storage-failed';
  if (/AssertionError|Assertion failed:/.test(text)) return 'assertion-failed';
  return 'process-failed';
}
function runCaptured(command, args, options = {}) {
  const identity = validIdentity(options.identity) ? options.identity : 'ci-command';
  const result = { identity, status: 'fail', category: 'capture-failed',
    exitCode: 1, signal: null, executed: false };
  let outFd, errFd;
  try {
    if (identity === 'ci-command' || typeof command !== 'string' || !command
        || !Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
      result.category = 'invalid-configuration';
      return result;
    }
    if (!COMMAND_IDS.has(identity) && ((command !== process.execPath && command !== 'node')
        || path.resolve(options.cwd || process.cwd(), args[0] || '') !==
          path.resolve(__dirname, '..', 'test', identity))) {
      result.category = 'invalid-configuration';
      return result;
    }
    const env = { ...process.env, ...options.env };
    const root = env.ATLAS_CI_DIAGNOSTICS_DIR || env.RUNNER_TEMP || os.tmpdir();
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const dir = fs.mkdtempSync(path.join(root, 'atlas-ci-private-'));
    fs.chmodSync(dir, 0o700);
    result.diagnosticsDirectory = dir;
    result.stdoutFile = options.stdoutFile || path.join(dir, 'stdout.log');
    result.stderrFile = path.join(dir, 'stderr.log');
    outFd = fs.openSync(result.stdoutFile, 'w', 0o600);
    errFd = fs.openSync(result.stderrFile, 'w', 0o600);
    fs.fchmodSync(outFd, 0o600);
    fs.fchmodSync(errFd, 0o600);
    // Runner commands on stdout/stderr are captured. File-based annotations
    // and summaries also cannot bypass capture into public runner channels.
    for (const key of ['GITHUB_STEP_SUMMARY', 'GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_PATH', 'GITHUB_STATE'])
      if (env[key]) env[key] = path.join(dir, key.toLowerCase() + '.private');
    result.executed = true;
    try {
      execFileSync(command, args, { cwd: options.cwd, env,
        stdio: [0, outFd, errFd], windowsHide: true });
      Object.assign(result, { status: 'pass', category: 'none', exitCode: 0 });
      result.syntheticProofVerified = identity === 'test-ci-output.js';
    } catch (error) {
      Object.assign(result, { category: categoryFor(error, result.stderrFile, identity),
        exitCode: Number.isInteger(error.status) ? error.status : null,
        signal: SIGNALS.has(error.signal) ? error.signal : null });
      if (result.category === 'spawn-failed') result.executed = false;
    }
  } catch (error) {
    if (result.diagnosticsDirectory) {
      try { fs.writeFileSync(path.join(result.diagnosticsDirectory, 'capture-error.log'),
        String(error.stack || error), { mode: 0o600 }); } catch { /* Fail closed. */ }
    }
    Object.assign(result, { status: 'fail', category: 'capture-failed', exitCode: 1, signal: null });
  } finally {
    for (const fd of [outFd, errFd]) {
      if (fd == null) continue;
      try { fs.closeSync(fd); }
      catch (error) {
        try { fs.writeFileSync(path.join(result.diagnosticsDirectory, 'close-error.log'),
          String(error.stack || error), { mode: 0o600 }); } catch { /* Fail closed. */ }
        if (result.exitCode === 0) Object.assign(result,
          { status: 'fail', category: 'capture-failed', exitCode: 1 });
      }
    }
    if (result.diagnosticsDirectory) {
      try { fs.writeFileSync(path.join(result.diagnosticsDirectory, 'outcome.json'), JSON.stringify({
        identity: result.identity, status: result.status, category: result.category,
        exitCode: result.exitCode, signal: result.signal, executed: result.executed }), { mode: 0o600 }); }
      catch (error) {
        try { fs.writeFileSync(path.join(result.diagnosticsDirectory, 'outcome-error.log'),
          String(error.stack || error), { mode: 0o600 }); } catch { /* Fail closed. */ }
        if (result.exitCode === 0) Object.assign(result,
          { status: 'fail', category: 'capture-failed', exitCode: 1 });
      }
    }
  }
  return result;
}
function main(argv) {
  let identity, cwd, stdoutFile;
  let index = 2;
  while (index < argv.length && argv[index] !== '--') {
    const option = argv[index++], value = argv[index++];
    if (option === '--identity') identity = value;
    else if (option === '--cwd') cwd = value;
    else if (option === '--stdout-file') stdoutFile = value;
    else { publish({ identity: 'ci-command', status: 'fail', category: 'invalid-configuration',
      exitCode: 1, signal: null, executed: false }); return 1; }
  }
  const command = argv[++index], args = argv.slice(index + 1);
  const result = runCaptured(command, args, { identity, cwd, stdoutFile });
  publish(result);
  if (result.signal && process.platform !== 'win32') process.kill(process.pid, result.signal);
  return result.exitCode == null ? 1 : result.exitCode;
}
if (require.main === module) {
  try { process.exitCode = main(process.argv); }
  catch { fs.writeSync(2, 'CI output capture failed.\n'); process.exitCode = 1; }
}
module.exports = { publicMode, suiteIdentity, startSuite, runCaptured, publish, main };
