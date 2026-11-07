'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const Privacy = require('../scripts/ci-repair-privacy');
const Gate = require('../scripts/atlas-cursor-repair-gate');
const Review = require('../scripts/atlas-review-block');
const ROOT = path.join(__dirname, '..');
const HEAD = 'a'.repeat(40), NEXT = 'b'.repeat(40);
const CANARY = 'CANARY_PRIVATE_REVIEW 947.31 2041-07-09';
const ENV = { GITHUB_REPOSITORY: 'synthetic/fixture', EVENT_NAME: 'workflow_dispatch',
  DISPATCH_PR: '42', DEFAULT_BRANCH: 'main' };
const BODY = 'Synthetic unchanged prose.\n### Atlas Contract / Systems Review\n'
  + '- **Required**: REQUIRED - review machinery\n- **Exact reviewed head**: N/A\n'
  + '- **Reviewer**: N/A\n- **Review outcome**: N/A\n- **Findings and fix verification**: N/A\n'
  + '### Unchanged section\nSynthetic byte-preservation token.\n';
function fixture(options = {}) {
  const pr = { number: 42, state: 'open', draft: options.draft || false,
    body: BODY, base: { ref: 'main' }, head: { sha: HEAD, ref: 'agent/synthetic' }, ...options.pr };
  const review = { id: 9, user: { login: options.login || Gate.TRUSTED_ATLAS_REVIEWER_LOGIN },
    commit_id: options.reviewHead || HEAD, body: options.reviewBody == null
      ? Gate.ATLAS_PASS_MARKER + '\n\n' + CANARY : options.reviewBody,
    submitted_at: '2041-07-09T00:00:00Z' };
  let gets = 0;
  const calls = [], patches = [], dispatches = [];
  const services = { api(route, request = {}) {
    calls.push({ route, request });
    if (options.apiError) throw new Error(CANARY);
    if (/\/commits\//.test(route)) return options.candidates || [{ number: 42 }];
    if (route.endsWith('/pulls/42')) {
      if (request.method === 'PATCH') {
        patches.push(request.body.body); pr.body = request.body.body;
        return { ...pr, arbitrary_response: CANARY };
      }
      gets++;
      const snapshot = JSON.parse(JSON.stringify(pr));
      if (gets === options.moveAt) snapshot.head.sha = NEXT;
      if (gets === options.bodyMoveAt) snapshot.body += 'Concurrent edit';
      return snapshot;
    }
    if (route.endsWith('/reviews')) return options.noReviews ? [] : [review];
    if (route.endsWith('/reviews/9')) return review;
    if (route.endsWith('/reviews/9/comments')) return options.comments || [];
    if (route.endsWith('/issues/42/comments')) return options.state || [];
    if (route.includes('/contents/')) return { encoding: 'base64', content: Buffer.from(
      options.workflow == null ? 'on:\n  workflow_dispatch:\n' : options.workflow).toString('base64') };
    throw new Error('unexpected synthetic API route');
  }, dispatch(...args) { dispatches.push(args); if (options.dispatchError) throw new Error(CANARY); } };
  return { services, calls, patches, dispatches, run(mode = 'codex-review', env = ENV) {
    return Privacy.run(mode, env, services);
  } };
}
function held(f) {
  assert.deepStrictEqual(f.run(), { code: 'private-artifact-blocked', exitCode: 78 });
  assert.strictEqual(f.dispatches.length, 0);
  assert.ok(!f.calls.some(c => /logs|artifacts/.test(c.route)));
}
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

(async () => {
  await checkWorkflowApiPrivacy();
  const pass = fixture();
  assert.deepStrictEqual(pass.run(), { code: 'trusted-pass-recorded', exitCode: 0 });
  assert.deepStrictEqual(pass.dispatches, [['agent/synthetic', 42, HEAD]]);
  assert.strictEqual(pass.patches.length, 1);
  assert.ok(!pass.patches[0].includes(CANARY));
  assert.ok(pass.patches[0].includes(Review.PASS_FINDINGS));
  assert.ok(pass.patches[0].endsWith('### Unchanged section\nSynthetic byte-preservation token.\n'));
  const fallback = fixture({ workflow: 'on:\n  pull_request:\n' });
  fallback.run(); assert.deepStrictEqual(fallback.dispatches, [['main', 42, HEAD]]);
  for (const label of ['NOT PASS', 'BLOCKING']) {
    const marker = Gate.ATLAS_BLOCKING_MARKERS.find(value => value.endsWith(label));
    const f = fixture({ reviewBody: marker + '\n\n' + CANARY });
    held(f); assert.strictEqual(f.patches.length, 1);
    assert.ok(f.patches[0].includes('Review outcome**: ' + label));
    assert.ok(f.patches[0].includes('See the submitted exact-head Atlas Contract / Systems Review.'));
    assert.ok(!f.patches[0].includes(CANARY));
  }
  const codex = { login: 'chatgpt-codex-connector[bot]', reviewBody: CANARY };
  for (const draft of [false, true]) {
    const f = fixture({ ...codex, draft }); held(f); assert.strictEqual(f.patches.length, 0);
  }
  for (const options of [{ login: 'untrusted', reviewBody: CANARY }, { reviewHead: NEXT },
    { noReviews: true }, { ...codex, reviewBody: '' }]) {
    const f = fixture(options); assert.strictEqual(f.run().exitCode, 0);
    assert.strictEqual(f.patches.length + f.dispatches.length, 0);
  }
  for (const state of [{ rounds: 3 }, { rounds: 1, last_reviewed_sha: HEAD }]) {
    const f = fixture({ ...codex, state: [{ body: Gate.serializeRepairState(state) }] });
    assert.strictEqual(f.run().code, 'repair-not-eligible');
    assert.strictEqual(f.patches.length + f.dispatches.length, 0);
  }
  for (const options of [{ moveAt: 2 }, { moveAt: 3 }, { bodyMoveAt: 3 }]) {
    const f = fixture(options); assert.throws(() => f.run(), /moved/);
    assert.strictEqual(f.patches.length + f.dispatches.length, 0);
  }
  for (const moveAt of [4, 5]) {
    const after = fixture({ moveAt }); assert.throws(() => after.run(), /moved/);
    assert.strictEqual(after.dispatches.length, 0);
  }
  const failed = fixture(); assert.strictEqual(failed.run('test-failure').exitCode, 78);
  assert.strictEqual(failed.calls.length, 1, 'failed logs and review prompts are never fetched');
  assert.strictEqual(failed.patches.length + failed.dispatches.length, 0);
  assert.strictEqual(fixture({ draft: true }).run('test-failure').code, 'draft-pr-skipped');
  for (const pr of [{ state: 'closed' }, { base: { ref: 'other' } }])
    assert.strictEqual(fixture({ pr }).run().code, 'pr-not-open-main');
  const resolved = fixture({ ...codex }); held({ ...resolved, run: () => resolved.run('codex-review',
    { ...ENV, EVENT_NAME: 'workflow_run', RUN_HEAD: HEAD }) });
  assert.strictEqual(fixture({ candidates: [] }).run('test-failure',
    { ...ENV, EVENT_NAME: 'workflow_run', RUN_HEAD: HEAD }).code, 'no-associated-pr');
  assert.throws(() => fixture().run('codex-review', { ...ENV, EVENT_NAME: CANARY }), /invalid-event-source/);
  assert.throws(() => fixture().run('codex-review', { ...ENV, DISPATCH_PR: CANARY }), /invalid-public-id/);
  for (const file of fs.readdirSync(path.join(ROOT, '.github/workflows')))
    assert.ok(!/upload-artifact|download-artifact/.test(fs.readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8')),
      'no cross-job plaintext artifact export exists: ' + file);
  for (const stage of ['fetch', 'helper', 'paginate', 'check']) await mergeCardCanary(stage);

  // Run the actual gate entry point and actual capture helper in a subprocess.
  // Stub only remote I/O; raw API stdout, stderr, errors and responses contain
  // invented canaries. No token, network, patch, prompt or artifact is needed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-privacy-canary-'));
  const gateFile = path.join(ROOT, 'scripts/ci-repair-privacy.js');
  const programs = [
    'process.env.EVENT_NAME="' + CANARY + '";',
    'const cp=require("child_process");cp.execFileSync=()=>{console.log(' + JSON.stringify(CANARY)
      + ');console.error(' + JSON.stringify(CANARY) + ');throw new Error(' + JSON.stringify(CANARY) + ');};',
    'const cp=require("child_process");cp.execFileSync=()=>{console.log(' + JSON.stringify(CANARY)
      + ');console.error(' + JSON.stringify(CANARY) + ');return ' + JSON.stringify(JSON.stringify(
        { number: 42, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: HEAD, ref: 'synthetic' }, body: CANARY })) + ';};',
  ];
  for (let i = 0; i < programs.length; i++) {
    const code = programs[i] + 'const p=require(' + JSON.stringify(gateFile)
      + ');process.exitCode=p.main(["node","gate","test-failure"]);';
    const child = spawnSync(process.execPath, [path.join(ROOT, 'scripts/ci-output.js'), '--identity',
      'atlas-test-repair-gate', '--', process.execPath, '-e', code],
    { cwd: ROOT, env: { ...process.env, ...ENV, ATLAS_CI_DIAGNOSTICS_DIR: dir }, encoding: 'utf8' });
    assert.strictEqual(child.status, i === 2 ? 78 : 1);
    assert.ok(!child.stdout.includes(CANARY) && !child.stderr.includes(CANARY));
    const record = JSON.parse(child.stdout);
    assert.strictEqual(record.exitCode, child.status);
    assert.strictEqual(record.category, i === 2 ? 'private-artifact-blocked' : 'process-failed');
  }
  console.log('PASS trusted exact-head review, unchanged authority, private API errors/responses, no artifacts, bounded hold and exact exit canaries.');
})().catch(error => { console.error(error); process.exitCode = 1; });
