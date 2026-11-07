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

// Next-move also boots five page contexts. Its longer deadline remains bounded
// and does not change the limit of any other refresh-isolation child.
function timeoutForSuite(file) {
  return file === 'test-nextmove.js' ? 600000 : 180000;
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

// The text of each "FAIL  <label>  — <detail>" line, without the detail.
function failLabels(out) {
  return String(out || '').split(/\r?\n/)
    .map(line => /^\s*FAIL\s+(.*)$/.exec(line)).filter(Boolean)
    .map(match => match[1].split('  — ')[0].trim());
}

// `allowed` maps a suite file to { completion, expected }:
//   completion — a RegExp for the suite's own final summary line, which it
//                prints only after running every check;
//   expected   — RegExps naming the assertions the mutated fact may fail.
// An allowed failure is expected only when the suite ran to that completion
// line, at least one FAIL was recorded, and every FAIL is a named one. A
// crash, timeout or signal after an expected FAIL, or any unnamed FAIL, stays
// an unexpected hard failure.
function isExpectedFailure(result, allowed) {
  const spec = allowed && Object.prototype.hasOwnProperty.call(allowed, result.file)
    ? allowed[result.file] : null;
  if (!spec || result.kind !== 'assertion-failure') return false;
  if (!(spec.completion instanceof RegExp) || !Array.isArray(spec.expected) || !spec.expected.length) return false;
  const lines = String(result.out || '').split(/\r?\n/).map(line => line.trim());
  if (!lines.some(line => spec.completion.test(line))) return false;
  const labels = failLabels(result.out);
  return labels.length > 0 && labels.every(label => spec.expected.some(pattern => pattern.test(label)));
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

module.exports = { withMutatedFixture, timeoutForSuite, runSuite, failLabels, isExpectedFailure, failureSummary, failureOutput };
