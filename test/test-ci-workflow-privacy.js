'use strict';
/* Live CI privacy and review-handoff pins.
 * `node test/test-ci-workflow-privacy.js`
 *
 * These checks used to live inside the suites for the retired review and
 * auto-repair scripts (removed under #822). They protect surfaces that are
 * still live, so they are kept here unchanged:
 *   - an API or helper failure inside the shipped privacy-guard, risk-label,
 *     labels and merge-card workflow scripts stays private and still fails;
 *   - no workflow exports a cross-job plaintext artifact;
 *   - merge-card-check keeps its required check identity and dispatcher;
 *   - the retired paid-reviewer workflows stay absent, and CLAUDE.md,
 *     CHATGPT.md and docs/RISK_LABELS.md keep the direct review handoff and
 *     the retired-repair wording.
 * Every canary value is invented.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { sourceText } = require('./test-source-text');
const ROOT = path.join(__dirname, '..');
const HEAD = 'a'.repeat(40), NEXT = 'b'.repeat(40);
const CANARY = 'CANARY_PRIVATE_REVIEW 947.31 2041-07-09';
async function mergeCardCanary(stage) {
  const source = fs.readFileSync(path.join(ROOT, '.github/workflows/merge-card-check.yml'), 'utf8');
  const script = source.split('          script: |')[1].split(/\r?\n/)
    .map(line => line.replace(/^            /, '')).join('\n');
  const annotations = [], writes = [], checkBodies = [];
  const github = { rest: { pulls: { listFiles() {}, get: async () => {
    if (stage === 'fetch') throw new Error(CANARY);
    return { data: { number: 42, state: 'open', body: CANARY,
      head: { sha: HEAD }, base: { ref: 'main', repo: { full_name: 'synthetic/fixture' } } } };
  } }, checks: { create: async body => { checkBodies.push(body);
    if (stage === 'check') throw new Error(CANARY); return { data: { id: 1 } };
  } } }, paginate: async () => { if (stage === 'paginate') throw new Error(CANARY); return []; } };
  const ctx = { require(name) {
    if (name === 'fs') return { writeFileSync: (...args) => writes.push(args) };
    if (stage === 'helper') throw new Error(CANARY);
    return require('../scripts/atlas-primary-risk');
  }, process: { env: { RUNNER_TEMP: 'private', GITHUB_WORKSPACE: ROOT }, cwd: () => ROOT },
  context: { eventName: 'workflow_dispatch', sha: NEXT, ref: 'refs/heads/main',
    repo: { owner: 'synthetic', repo: 'fixture' }, payload: { repository: { default_branch: 'main' },
      inputs: { pr_number: '42', expected_head_sha: HEAD } } },
  core: { setFailed: value => annotations.push(value), info: value => annotations.push(value) }, github };
  await vm.runInNewContext('(async () => {' + script + '\n})()', ctx);
  assert.strictEqual(annotations.length, 1);
  assert.ok(!JSON.stringify({ annotations, checkBodies }).includes(CANARY));
  assert.ok(writes.some(row => String(row[1]).includes(CANARY)), 'API failure is private and retained');
}
// Exercise the shipped action bodies, including github-script@v7's public
// unhandled-error sink. Only remote I/O and the filesystem are stubbed.
function workflowScripts(source) {
  return [...source.matchAll(/          script: \|\r?\n((?:            .*\r?\n|\r?\n)*)/g)]
    .map(row => row[1].split(/\r?\n/).map(line => line.replace(/^            /, '')).join('\n'));
}
async function workflowApiCanary(file, index, stage, source) {
  source = source || fs.readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8');
  const messages = [], writes = [], calls = [];
  let failed = false, escaped = false;
  const manifest = '- name: "' + CANARY + '"\n  color: abcdef\n  description: Synthetic fixture.\n';
  const failure = status => Object.assign(new Error(CANARY), { status });
  const github = { rest: { repos: { createCommitStatus: async params => {
    calls.push({ method: 'status', params });
    if (stage === 'api' || stage === 'private-write') throw failure(503);
  } }, issues: {
    updateLabel: async params => {
      calls.push({ method: 'update', params });
      if (stage === 'update') throw failure(503);
      if (stage === 'create' || stage === 'create-success') throw failure(404);
    }, createLabel: async params => {
      calls.push({ method: 'create', params });
      if (stage === 'create') throw failure(503);
    },
  } } };
  const ctx = {
    require: name => {
      assert.strictEqual(name, 'fs');
      return { readFileSync: () => {
        if (stage === 'read') throw failure();
        return stage === 'empty' ? '' : manifest;
      }, writeFileSync: (...args) => {
        if (stage === 'private-write') throw failure();
        writes.push(args);
      } };
    }, process: { env: { RUNNER_TEMP: 'private' } }, github,
    context: { repo: { owner: 'synthetic', repo: 'fixture' },
      payload: { pull_request: { head: { sha: HEAD } } }, serverUrl: 'https://example.test', runId: 42 },
    core: { setFailed: value => { failed = true; messages.push(value); }, info: value => messages.push(value),
      summary: { addRaw: value => messages.push(value), write: async () => {
        if (stage === 'summary') throw failure();
      } } },
  };
  const script = workflowScripts(source)[index]
    .replace('${{ steps.scan.outcome }}', stage === 'scan-failure' ? 'failure' : 'success');
  try { await vm.runInNewContext('(async () => {' + script + '\n})()', ctx); }
  catch (error) {
    // v7 logs the escaped error and annotates its message; do not let a stub
    // hide that real action behavior when testing the publication boundary.
    escaped = true; failed = true;
    messages.push(String(error.stack || error), 'Unhandled error: ' + String(error));
  }
  return { failed, escaped, publicLeak: messages.some(value => String(value).includes(CANARY)),
    retained: writes.some(row => String(row[1]).includes(CANARY)), calls, writes };
}
function riskShellCanary(source) {
  source = source || fs.readFileSync(path.join(ROOT, '.github/workflows/risk-label-gate.yml'), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-api-canary-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const gh = path.join(bin, 'gh');
  fs.writeFileSync(gh, '#!/bin/sh\nprintf "called\\n" >> "$STUB_CALLS"\n'
    + 'printf "%s\\n" "' + CANARY + '"\nprintf "%s\\n" "' + CANARY + '" >&2\nexit 7\n', { mode: 0o700 });
  const shell = source.split('        run: |')[1].split(/\r?\n/)
    .map(line => line.replace(/^          /, '')).join('\n');
  const env = { ...process.env, STUB_BIN: bin.replace(/\\/g, '/'),
    STUB_CALLS: path.join(dir, 'calls').replace(/\\/g, '/'), RUNNER_TEMP: dir,
    ATLAS_CI_DIAGNOSTICS_DIR: dir, EVENT_NAME: 'pull_request_target', EVENT_NUMBER: '42', EVENT_HEAD: HEAD,
    GITHUB_REPOSITORY: 'synthetic/fixture', GITHUB_SERVER_URL: 'https://example.test', GITHUB_RUN_ID: '42' };
  delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
  const prelude = process.platform === 'win32' ? 'stub="$(cygpath -u "$STUB_BIN")"\n'
    : 'stub="$STUB_BIN"\n';
  const child = spawnSync(process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash',
    ['-c', prelude + 'export PATH="$stub:$PATH"\n'
      + '[ "$(command -v gh)" = "$stub/gh" ] || exit 125\n' + shell],
    { cwd: ROOT, env, encoding: 'utf8', windowsHide: true });
  const logs = fs.readdirSync(dir).filter(name => name.startsWith('atlas-ci-private-'))
    .flatMap(name => fs.readdirSync(path.join(dir, name)).filter(file => file.endsWith('.log'))
      .map(file => fs.readFileSync(path.join(dir, name, file), 'utf8')));
  return { exitCode: child.status, spawnError: !!child.error,
    publicLeak: String(child.stdout).includes(CANARY) || String(child.stderr).includes(CANARY),
    retained: logs.some(log => log.includes(CANARY)),
    calls: fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').length : 0,
    record: child.stdout && child.stdout.trim().startsWith('{') ? JSON.parse(child.stdout) : null };
}
async function checkWorkflowApiPrivacy() {
  for (const [file, index] of [['privacy-guard.yml', 0], ['privacy-guard.yml', 1], ['risk-label-gate.yml', 0]]) {
    const api = await workflowApiCanary(file, index, 'api');
    assert.ok(api.failed && !api.escaped && !api.publicLeak && api.retained, file + ' API error remains private and fails');
    assert.strictEqual(api.calls.length, 1);
    assert.strictEqual(api.calls[0].params.sha, HEAD, 'status remains attached to the event head');
    assert.strictEqual(api.calls[0].params.state, file === 'privacy-guard.yml' && index === 1 ? 'success' : 'pending');
    assert.strictEqual(api.writes[0][2].mode, 0o600);
    const pass = await workflowApiCanary(file, index, 'success');
    assert.ok(!pass.failed && !pass.escaped && !pass.publicLeak);
    assert.strictEqual(pass.calls.length, 1, 'successful API operation still runs once');
    const storageFailure = await workflowApiCanary(file, index, 'private-write');
    assert.ok(storageFailure.failed && !storageFailure.escaped && !storageFailure.publicLeak,
      'private diagnostic storage failure cannot disclose the API exception');
  }
  const rejected = await workflowApiCanary('privacy-guard.yml', 1, 'scan-failure');
  assert.ok(rejected.failed && !rejected.escaped && !rejected.publicLeak);
  assert.strictEqual(rejected.calls[0].params.state, 'failure', 'a rejected scan remains rejected');
  for (const stage of ['update', 'create', 'read', 'summary']) {
    const result = await workflowApiCanary('labels.yml', 0, stage);
    assert.ok(result.failed && !result.escaped && !result.publicLeak && result.retained,
      'label ' + stage + ' error remains private and fails');
    assert.strictEqual(result.writes[0][2].mode, 0o600);
    assert.strictEqual(result.calls.length, stage === 'read' ? 0 : stage === 'create' ? 2 : 1);
  }
  for (const stage of ['success', 'create-success']) {
    const result = await workflowApiCanary('labels.yml', 0, stage);
    assert.ok(!result.failed && !result.escaped && !result.publicLeak);
    assert.deepStrictEqual(result.calls.map(row => row.method), stage === 'success' ? ['update'] : ['update', 'create']);
    for (const row of result.calls) {
      assert.strictEqual(row.params.name, CANARY, 'the manifest remains the label authority');
      assert.strictEqual(row.params.color, 'abcdef');
      assert.strictEqual(row.params.description, 'Synthetic fixture.');
    }
  }
  const empty = await workflowApiCanary('labels.yml', 0, 'empty');
  assert.ok(empty.failed && !empty.escaped && !empty.publicLeak);
  assert.strictEqual(empty.calls.length, 0);
  const shell = riskShellCanary();
  assert.strictEqual(shell.exitCode, 7, 'shell API failure preserves the exact exit');
  assert.strictEqual(shell.spawnError, false);
  assert.strictEqual(shell.calls, 1, 'only the local executable API stub runs');
  assert.ok(!shell.publicLeak && shell.retained, 'actual shell stdout and stderr stay private');
  assert.strictEqual(shell.record.identity, 'risk-label-gate');
  assert.strictEqual(shell.record.category, 'process-failed');
  const authority = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8').replace(/\r\n/g, '\n');
  const flat = authority.replace(/\s+/g, ' ');
  // The suspended repair workflows are retired; the authority text must say so
  // and must not promise automatic repair or its restoration by re-adding them.
  assert.ok(flat.includes('were retired on 2026-11-03'));
  assert.ok(flat.includes('Repair requires a local fix, the normal tests, and genuine review'));
  assert.ok(flat.includes('requires a new, separately reviewed implementation'));
  assert.ok(!authority.includes('checks start one automatic Cursor'));
}


function checkShippedWorkflowsAndHandoff() {
  for (const file of fs.readdirSync(path.join(ROOT, '.github/workflows')))
    assert.ok(!/upload-artifact|download-artifact/.test(fs.readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8')),
      'no cross-job plaintext artifact export exists: ' + file);
  const mergeCard = sourceText(fs.readFileSync(path.join(ROOT, '.github/workflows/merge-card-check.yml'), 'utf8'));
  assert.ok(/workflow_dispatch:/.test(mergeCard) && /REQUIRED_CHECK_NAME = 'Merge card mechanical fields'/.test(mergeCard),
    'required mechanical check identity and dispatcher remain');
  assert.ok(/github.rest.checks.create/.test(mergeCard) && /github.rest.pulls.get/.test(mergeCard),
    'default-branch fallback still validates the live PR and records its check');
  for (const retiredPath of ['.github/workflows/atlas-first-review-dispatch.yml', '.github/workflows/atlas-first-review.yml',
    '.github/workflows/atlas-rereview-dispatch.yml', '.github/workflows/atlas-rereview.yml'])
    assert.ok(!fs.existsSync(path.join(ROOT, retiredPath)), 'retired paid reviewer workflow is absent: ' + retiredPath);
  const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  const chatgpt = fs.readFileSync(path.join(ROOT, 'CHATGPT.md'), 'utf8');
  const riskLabels = fs.readFileSync(path.join(ROOT, 'docs/RISK_LABELS.md'), 'utf8');
  assert.ok(/deliver the review request directly to the named reviewer\s+—\s+for Atlas, the active ChatGPT\s+decision-desk session/.test(claude),
    'governance requires a direct handoff to the named reviewer (Atlas: the active ChatGPT decision desk)');
  assert.ok(/cannot\s+wake ChatGPT and does not start or satisfy this review/.test(claude),
    'governance says GitHub artifacts cannot wake or satisfy ChatGPT review');
  assert.ok(/Paid OpenAI reviewer\s+workflows are retired\. Do not wait for them\./.test(claude),
    'governance retires the misleading paid reviewer wait');
  assert.ok(/A GitHub review, comment, label, or workflow run is evidence only/.test(claude),
    'GitHub handoff artifacts remain evidence rather than dispatch authority');
  assert.ok(/## Required review handoff/.test(chatgpt) && /pull request number, current full head SHA/.test(chatgpt),
    'the ChatGPT adapter requires PR number and exact head in the direct request');
  assert.ok(/successful workflow\s+as a request to ChatGPT/.test(chatgpt) && /cannot wake this session/.test(chatgpt),
    'the ChatGPT adapter rejects a green workflow as a review request');
  assert.ok(/posts\s+factual findings as a PR comment/.test(chatgpt) && /mirrors the exact reviewed SHA/.test(chatgpt),
    'the manual handoff records factual findings on the exact reviewed head');
  assert.ok(/If\s+the head moves, request review again on the new full SHA/.test(chatgpt),
    'a moved repair head requires a new direct exact-head review request');
  assert.ok(/any prior blocking finding that bounds a\s+re-review/.test(chatgpt),
    'bounded re-review carries the prior blocking finding');
  assert.ok(/Their parked\s+versions exited successfully without performing a review/.test(riskLabels),
    'risk documentation records the demonstrated false-progress failure');
  assert.ok(/do not wake ChatGPT, satisfy the review, or add API spend/.test(riskLabels),
    'risk documentation keeps manual review required without API spend');
}

(async () => {
  await checkWorkflowApiPrivacy();
  for (const stage of ['fetch', 'helper', 'paginate', 'check']) await mergeCardCanary(stage);
  checkShippedWorkflowsAndHandoff();
  console.log('PASS live workflow API errors stay private and fail; no artifacts; merge-card check identity; retired reviewer workflows absent; direct review handoff wording.');
})().catch(error => { console.error(error); process.exitCode = 1; });
