'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

function withMutatedFixture(root, mutate, fn) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-refresh-isolation-'));
  try {
    // Independent history/index are needed by the existing static and historical
    // reconciliation suites. No shared objects, worktree links or source writes.
    execFileSync('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', '--', root, fixture],
      { encoding: 'utf8' });
    // Exercise this checkout's current tracked bytes, including uncommitted test
    // edits, rather than silently testing only the last commit. Ignored private
    // files (raw/, derived/, .env, local provider mappings) never enter the copy.
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    // Copy the source index, including staged blobs/modes and any split-index
    // backing file. The local clone has independent copies of its Git objects.
    const index = git(['rev-parse', '--git-path', 'index']).trim();
    fs.copyFileSync(path.resolve(root, index), path.join(fixture, '.git', 'index'));
    const shared = git(['rev-parse', '--shared-index-path']).trim();
    if (shared) fs.copyFileSync(path.resolve(root, shared),
      path.join(fixture, '.git', path.basename(shared)));
    const indexed = git(['ls-files', '-z']);
    const committed = git(['ls-tree', '-r', '--name-only', '-z', 'HEAD']);
    // Only copy files physically present in this working tree. HEAD paths also
    // cover an index-only deletion whose file still exists locally; missing
    // staged/unstaged deletions and old rename paths must never be resurrected.
    const files = new Set((indexed + committed).split('\0').filter(Boolean));
    for (const file of files) {
      const source = path.join(root, file);
      if (!fs.existsSync(source)) continue;
      const target = path.join(fixture, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    const dataPath = path.join(fixture, 'data.json');
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    mutate(data);
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2) + '\n');
    return fn(fixture);
  } finally {
    // A forced process kill can bypass finally and leave this temporary copy.
    // The canonical file is never written, so cancellation needs no restoration.
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

// Three children are CPU-heavy and measured near the default limit when the four
// cases share a hosted runner: next-move boots five page contexts; status-band
// and counterfactuals took 155-160s of the 180s default on a 2-CPU local run
// that mirrors a slow hosted runner. Each gets a longer but still bounded
// deadline; every other child keeps 180s. A timeout stays a hard failure.
const LONG_RUNNING = Object.freeze({
  'test-nextmove.js': 600000,
  'test-status-band.js': 600000,
  'test-counterfactuals.js': 600000,
});
function timeoutForSuite(file) {
  return Object.prototype.hasOwnProperty.call(LONG_RUNNING, file) ? LONG_RUNNING[file] : 180000;
}

function runSuite(file, root, { execute = execFileSync, now = Date.now } = {}) {
  const timeoutMs = timeoutForSuite(file);
  const started = now();
  try {
    const out = execute(process.execPath, [path.join(root, 'test', file)], {
      cwd: root, encoding: 'utf8', timeout: timeoutMs,
    });
    return { file, ok: true, fails: 0, out, kind: 'success', code: null,
      status: 0, signal: null, elapsedMs: now() - started, timeoutMs };
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    const fails = (out.match(/^\s*FAIL\s/gm) || []).length;
    const kind = e.code === 'ETIMEDOUT' ? 'timeout'
      : e.signal ? 'signal'
      : fails > 0 && Number.isInteger(e.status) && e.status !== 0
        ? 'assertion-failure' : 'execution-failure';
    return { file, ok: false, fails, out, kind, code: e.code || null,
      status: e.status == null ? null : e.status, signal: e.signal || null,
      elapsedMs: now() - started, timeoutMs };
  }
}

function isExpectedFailure(result, allowed) {
  // An allowed live-reconciliation assertion must actually have run and failed.
  // Timeouts, signals and execution errors remain unexpected hard failures.
  return result.kind === 'assertion-failure' && allowed.includes(result.file);
}

function failureSummary(result) {
  return `${result.file}: ${result.kind}; ${result.fails} assertion(s); ` +
    `elapsed=${result.elapsedMs}ms; limit=${result.timeoutMs}ms; ` +
    `code=${result.code}; status=${result.status}; signal=${result.signal}`;
}

function failureOutput(result) {
  // Preserve all captured output, including evidence of child termination.
  return `  FAIL  ${failureSummary(result)}\n` +
    `--- captured output: ${result.file} ---\n${result.out || '(no captured output)'}\n` +
    `--- end captured output: ${result.file} ---`;
}

module.exports = { withMutatedFixture, timeoutForSuite, runSuite, isExpectedFailure, failureSummary, failureOutput };
