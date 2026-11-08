'use strict';
/* B77: GitHub/API-authored commits must still face the incumbent privacy
 * guard. `node test/test-privacy-guard.js`
 *
 * Synthetic fixtures only. This file must not contain household identifiers
 * or secret assignment forms from the incumbent policy list.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const GUARD = path.join(ROOT, 'scripts', 'privacy-guard.js');
const HOOK = path.join(ROOT, '.githooks', 'pre-commit');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'privacy-guard.yml');
const SYNTHETIC = 'SYNTHETIC_B77_HOUSEHOLD_TOKEN';

const guard = require(GUARD);

let failures = 0;
function ok(cond, label, detail = '') {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-b77-'));
}

function write(dir, rel, body) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function git(dir, args, extra = {}) {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...extra,
  });
}

function initRepo() {
  const dir = tmpDir();
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'b77-fixture@example.test']);
  git(dir, ['config', 'user.name', 'B77 Fixture']);
  git(dir, ['config', 'core.hooksPath', '/dev/null']);
  return dir;
}

function commit(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

function runGuard(args, cwd = ROOT) {
  return spawnSync(process.execPath, [GUARD, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

console.log('=== one policy file, no second list ===');
const hookSrc = fs.readFileSync(HOOK, 'utf8');
const guardSrc = fs.readFileSync(GUARD, 'utf8');
const workflowSrc = fs.readFileSync(WORKFLOW, 'utf8');
const staticSrc = fs.readFileSync(path.join(ROOT, 'test', 'test-static.js'), 'utf8');
ok(/privacy-guard\.js" --staged/.test(hookSrc),
  'local hook delegates to the sole engine');
ok(!/CONTENT_PATTERNS/.test(hookSrc) && !/^patterns=/m.test(hookSrc),
  'hook does not keep a second identifier list');
ok(/const CONTENT_PATTERNS = /.test(guardSrc), 'engine declares the sole content-policy constant');
ok(/LUNCHMONEY_ACCESS_TOKEN/.test(guardSrc)
  && /ATLAS_PROVIDER_ACCOUNT_MAP_JSON/.test(guardSrc)
  && /ATLAS_ASSISTANT_TOKEN/.test(guardSrc)
  && /ATLAS_TALK_GEMINI_API_KEY/.test(guardSrc)
  && /SITE_PASSWORD/.test(guardSrc)
  && /SESSION_SECRET/.test(guardSrc),
  'engine still names the incumbent secret tokens');
ok(!/CONTENT_PATTERNS/.test(workflowSrc), 'workflow does not embed the content-policy constant');
ok(!/CONTENT_PATTERNS/.test(staticSrc), 'static suite does not copy the incumbent identifier list');

console.log('\n=== tracked tree stays inside the incumbent policy ===');
{
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const extra = [];
  for (const file of tracked) {
    if (guard.SKIP_CONTENT_RE.test(file)) continue;
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
    const body = fs.readFileSync(full, 'utf8');
    const hits = guard.scanFiles({
      files: [file],
      patterns: guard.CONTENT_PATTERNS,
      readFile: () => body,
    }).filter((f) => f.kind === 'content');
    if (hits.length) extra.push(file);
  }
  ok(extra.length === 0,
    'no tracked file outside the policy engine carries incumbent identifier/secret content',
    extra.join(', ') || `${tracked.length} files`);
}

console.log('\n=== synthetic content and path policy ===');
{
  const patterns = SYNTHETIC;
  const clean = guard.scanFiles({
    files: ['notes.txt'],
    patterns,
    readFile: () => 'ordinary household documentation',
  });
  ok(clean.length === 0, 'clean text is accepted');

  const dirty = guard.scanFiles({
    files: ['interview.txt'],
    patterns,
    readFile: () => `line one\nleaked ${SYNTHETIC} here\nline three`,
  });
  ok(dirty.length === 1 && dirty[0].kind === 'content' && dirty[0].file === 'interview.txt',
    'synthetic identifier in a .txt file is rejected');

  const pdf = guard.scanFiles({
    files: ['statement.pdf'],
    patterns,
    readFile: () => 'clean',
  });
  ok(pdf.length === 1 && pdf[0].kind === 'path', 'a .pdf path is rejected without reading content');

  const raw = guard.scanFiles({
    files: ['raw/export.csv'],
    patterns,
    readFile: () => 'clean',
  });
  ok(raw.length === 1 && raw[0].kind === 'path', 'a raw/ path is rejected');

  const derived = guard.scanFiles({
    files: ['derived/tmp.json'],
    patterns,
    readFile: () => 'clean',
  });
  ok(derived.length === 1 && derived[0].kind === 'path', 'a derived/ path is rejected');

  const skipped = guard.scanFiles({
    files: ['scripts/privacy-guard.js'],
    patterns,
    readFile: () => SYNTHETIC,
  });
  ok(skipped.length === 0, 'the policy engine file is not scanned against its own list');
}

console.log('\n=== CLI: staged hook path and changed-from CI path ===');
{
  const dir = initRepo();
  const patternsFile = path.join(dir, 'synthetic.patterns');
  fs.writeFileSync(patternsFile, `${SYNTHETIC}\n`);
  write(dir, 'README.md', 'clean start\n');
  const base = commit(dir, 'base');

  write(dir, 'docs/note.txt', 'still clean\n');
  git(dir, ['add', 'docs/note.txt']);
  const cleanStaged = runGuard(['--staged', '--root', dir, '--patterns-file', patternsFile]);
  ok(cleanStaged.status === 0, 'staged clean file exits 0', String(cleanStaged.status));

  write(dir, 'docs/leak.txt', `connector paste ${SYNTHETIC}\n`);
  git(dir, ['add', 'docs/leak.txt']);
  const dirtyStaged = runGuard(['--staged', '--root', dir, '--patterns-file', patternsFile]);
  ok(dirtyStaged.status === 1, 'staged synthetic identifier exits 1', String(dirtyStaged.status));
  ok(/BLOCKED: docs\/leak\.txt/.test(dirtyStaged.stderr),
    'staged rejection names the file');

  git(dir, ['reset', 'HEAD', 'docs/leak.txt']);
  fs.unlinkSync(path.join(dir, 'docs/leak.txt'));
  const head = commit(dir, 'clean change');
  ok(/^[0-9a-f]{40}$/.test(head), 'clean commit has a full SHA');

  write(dir, 'notes.pdf', 'not a real statement');
  commit(dir, 'add pdf');
  const pdfCli = runGuard(['--root', dir, '--changed-from', base, '--patterns-file', patternsFile]);
  ok(pdfCli.status === 1, 'changed-from rejects an added pdf', String(pdfCli.status));
  ok(/BLOCKED: raw financial data/.test(pdfCli.stderr), 'path rejection uses the incumbent wording');

  fs.rmSync(path.join(dir, 'notes.pdf'));
  write(dir, 'docs/api-commit.txt', `GitHub API ${SYNTHETIC}\n`);
  commit(dir, 'api authored leak');
  const leakCli = runGuard(['--root', dir, '--changed-from', base, '--patterns-file', patternsFile]);
  ok(leakCli.status === 1, 'changed-from rejects synthetic identifier content', String(leakCli.status));

  const missingSha = runGuard(['--root', dir, '--changed-from', 'not-a-sha', '--patterns-file', patternsFile]);
  ok(missingSha.status === 1, 'invalid changed-from SHA fails closed');

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== quoted / non-ASCII pathnames cannot skip the scan ===');
ok(/\['diff', '-z', '--cached'/.test(guardSrc),
  'staged listing requests NUL-delimited git pathnames');
ok(/\['diff', '-z', '--name-only'/.test(guardSrc),
  'changed-from listing requests NUL-delimited git pathnames');
{
  const dir = initRepo();
  const patternsFile = path.join(dir, 'synthetic.patterns');
  fs.writeFileSync(patternsFile, `${SYNTHETIC}\n`);
  write(dir, 'README.md', 'clean start\n');
  const base = commit(dir, 'base');
  const quotedRel = 'docs/résumé.txt';
  write(dir, quotedRel, `connector paste ${SYNTHETIC}\n`);
  git(dir, ['add', quotedRel]);

  const quotedDiff = git(dir, ['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
  ok(/\\303\\251|"/.test(quotedDiff),
    'independent proof: default git name-only output quotes the non-ASCII pathname',
    JSON.stringify(quotedDiff));
  ok(!fs.existsSync(path.join(dir, quotedDiff.trim())),
    'the quoted git name is not a filesystem path');

  const dirtyStaged = runGuard(['--staged', '--root', dir, '--patterns-file', patternsFile]);
  ok(dirtyStaged.status === 1, 'staged non-ASCII pathname with blocked pattern exits 1',
    String(dirtyStaged.status));
  ok(dirtyStaged.stderr.includes(quotedRel),
    'staged rejection names the real non-ASCII path');

  const head = commit(dir, 'non-ascii leak');
  ok(/^[0-9a-f]{40}$/.test(head), 'non-ASCII leak commit has a full SHA');
  const dirtyChanged = runGuard(['--root', dir, '--changed-from', base, '--patterns-file', patternsFile]);
  ok(dirtyChanged.status === 1, 'changed-from non-ASCII pathname with blocked pattern exits 1',
    String(dirtyChanged.status));
  ok(dirtyChanged.stderr.includes(quotedRel),
    'changed-from rejection names the real non-ASCII path');

  const zOut = git(dir, ['diff', '-z', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`]);
  ok(zOut.split('\0').filter(Boolean).includes(quotedRel),
    'NUL-delimited git output carries the real pathname');

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== a weakened incoming engine must not be the judge ===');
{
  const dir = initRepo();
  const patternsFile = path.join(dir, 'synthetic.patterns');
  fs.writeFileSync(patternsFile, `${SYNTHETIC}\n`);
  write(dir, 'ok.md', 'clean\n');
  const base = commit(dir, 'base');
  write(dir, 'docs/leak.txt', `${SYNTHETIC}\n`);
  write(dir, 'scripts/privacy-guard.js', "const CONTENT_PATTERNS = 'NEVER_MATCH';\n");
  commit(dir, 'weaken guard and leak');

  const trusted = runGuard(['--root', dir, '--changed-from', base, '--patterns-file', patternsFile]);
  ok(trusted.status === 1, 'trusted patterns still reject the leak when the incoming engine is weakened');

  const incomingEngine = spawnSync(process.execPath, ['-e', `
    const assert = require('assert');
    assert.strictEqual('NEVER_MATCH', 'NEVER_MATCH');
  `], { encoding: 'utf8' });
  ok(incomingEngine.status === 0, 'sanity: a weakened list can be constructed');
  ok(/trusted\/scripts\/privacy-guard\.js/.test(workflowSrc)
    && /--changed-from/.test(workflowSrc),
    'CI runs the trusted engine, not the incoming copy');
  ok(!/node incoming\//.test(workflowSrc) && !/incoming\/scripts\/privacy-guard/.test(workflowSrc),
    'CI never executes incoming JavaScript');
  ok(!/--patterns-file/.test(workflowSrc), 'CI cannot swap in a synthetic or empty pattern list');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== shipped workflow cannot be rewritten by the PR it judges ===');
ok(/pull_request_target:/.test(workflowSrc), 'workflow runs from trusted default-branch pull_request_target');
// A PR run checks out the default branch; a merge-queue run checks out the
// group's base commit, which is on main. Neither is the incoming write.
ok(/ref:\s*\$\{\{\s*github\.event\.merge_group\.base_sha \|\| github\.event\.repository\.default_branch\s*\}\}\n\s*persist-credentials:\s*false\n\s*path:\s*trusted/.test(workflowSrc),
  'guard checkout is the default branch (merge queue: its base on main) with credentials disabled');
ok(/github\.event\.pull_request\.head\.sha/.test(workflowSrc)
  && /github\.event\.pull_request\.head\.repo\.full_name/.test(workflowSrc),
  'incoming checkout is the PR head, treated as data');
ok(/path:\s*incoming/.test(workflowSrc) && /path:\s*trusted/.test(workflowSrc),
  'trusted guard and incoming write are separate checkouts');
ok(/context:\s*'privacy-guard'/.test(workflowSrc)
  && /createCommitStatus/.test(workflowSrc),
  'result is published onto the PR head, not the default-branch job SHA');
ok(/if:\s*always\(\)/.test(workflowSrc), 'status publish is fail-closed');
ok(!/CURSOR_API_KEY|OPENAI_API_KEY|ATLAS_AUTOMATION_TOKEN/.test(workflowSrc),
  'privacy guard does not use repository secrets');

console.log('\n=== content that cannot be read, or is large, or changed type, is still judged ===');
{
  // Independent proofs: every expectation below is derived from git itself
  // and from fixture bytes written here, not from the guard's helpers.
  const dir = initRepo();
  const patternsFile = path.join(dir, 'synthetic.patterns');
  fs.writeFileSync(patternsFile, `${SYNTHETIC}\n`);
  const staged = () => runGuard(['--staged', '--root', dir, '--patterns-file', patternsFile]);
  write(dir, 'README.md', 'clean start\n');
  fs.symlinkSync('README.md', path.join(dir, 'link.txt'));
  const base = commit(dir, 'base with a symlink');
  ok(git(dir, ['ls-files', '-s', 'link.txt']).startsWith('120000'),
    'fixture: link.txt is tracked as a symlink');

  // A3: a staged file larger than Node's default 1 MiB child-process buffer.
  const bigBody = `${'x'.repeat(1100 * 1024)}\nlate ${SYNTHETIC}\n`;
  write(dir, 'public/big.js', bigBody);
  git(dir, ['add', 'public/big.js']);
  ok(Number(git(dir, ['cat-file', '-s', ':public/big.js']).trim()) > 1024 * 1024,
    'fixture: staged blob is over 1 MiB');
  const bigStaged = staged();
  ok(bigStaged.status === 1 && /BLOCKED: public\/big\.js contains/.test(bigStaged.stderr),
    'staged >1 MiB file with a canary is rejected', String(bigStaged.status));
  git(dir, ['reset', '-q', 'public/big.js']);
  write(dir, 'public/big.js', `${'x'.repeat(1100 * 1024)}\nclean tail\n`);
  git(dir, ['add', 'public/big.js']);
  const bigClean = staged();
  ok(bigClean.status === 0, 'staged >1 MiB clean file is accepted',
    `${bigClean.status} ${bigClean.stderr.slice(0, 200)}`);
  git(dir, ['reset', '-q', 'public/big.js']);
  fs.rmSync(path.join(dir, 'public'), { recursive: true });

  // A4: symlink replaced by a regular file holding a canary (status T).
  fs.unlinkSync(path.join(dir, 'link.txt'));
  write(dir, 'link.txt', `pasted ${SYNTHETIC}\n`);
  git(dir, ['add', 'link.txt']);
  ok(/^T\tlink\.txt$/m.test(git(dir, ['diff', '--cached', '--name-status'])),
    'fixture: git reports the staged change as a type change (T)');
  const tcStaged = staged();
  ok(tcStaged.status === 1 && /BLOCKED: link\.txt contains/.test(tcStaged.stderr),
    'staged symlink-to-file type change with a canary is rejected', String(tcStaged.status));
  git(dir, ['commit', '-q', '-m', 'type change leak']);
  ok(/^T\tlink\.txt$/m.test(git(dir, ['diff', '--name-status', `${base}...HEAD`])),
    'fixture: git reports base...HEAD as a type change (T)');
  const tcChanged = runGuard(['--root', dir, '--changed-from', base, '--patterns-file', patternsFile]);
  ok(tcChanged.status === 1 && /BLOCKED: link\.txt contains/.test(tcChanged.stderr),
    'changed-from symlink-to-file type change with a canary is rejected', String(tcChanged.status));

  // Fail closed: a staged entry whose blob cannot be read.
  const base2 = git(dir, ['rev-parse', 'HEAD']).trim();
  write(dir, 'docs/lost.txt', `blob body ${SYNTHETIC} unique-${Date.now()}\n`);
  git(dir, ['add', 'docs/lost.txt']);
  const oid = git(dir, ['rev-parse', ':docs/lost.txt']).trim();
  fs.rmSync(path.join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
  const missingBlob = spawnSync('git', ['cat-file', '-e', oid], { cwd: dir });
  ok(missingBlob.status !== 0, 'fixture: the staged blob is no longer readable by git');
  const lostStaged = staged();
  ok(lostStaged.status === 1 && /could not read[\s\S]*docs\/lost\.txt/.test(lostStaged.stderr),
    'staged unreadable blob fails closed and names the file', String(lostStaged.status));
  git(dir, ['rm', '-q', '--cached', 'docs/lost.txt']);
  fs.rmSync(path.join(dir, 'docs'), { recursive: true });

  // Fail closed: changed-from lists a file the checkout cannot read.
  write(dir, 'notes/gone.txt', 'committed then missing from the checkout\n');
  commit(dir, 'add gone');
  fs.rmSync(path.join(dir, 'notes', 'gone.txt'));
  const goneChanged = runGuard(['--root', dir, '--changed-from', base2, '--patterns-file', patternsFile]);
  ok(goneChanged.status === 1 && /could not read[\s\S]*notes\/gone\.txt/.test(goneChanged.stderr),
    'changed-from unreadable file fails closed and names the file', String(goneChanged.status));
  git(dir, ['checkout', '-q', '--', 'notes/gone.txt']);

  // A symlink's committed content is its target text; CI judges that text,
  // as the staged path already does, instead of following the link.
  const base4 = git(dir, ['rev-parse', 'HEAD']).trim();
  fs.symlinkSync(`nowhere/${SYNTHETIC}`, path.join(dir, 'bad-link'));
  git(dir, ['add', 'bad-link']);
  ok(git(dir, ['cat-file', '-p', ':bad-link']).includes(SYNTHETIC),
    'fixture: git records the symlink target text as the blob');
  const linkStaged = staged();
  ok(linkStaged.status === 1 && /BLOCKED: bad-link contains/.test(linkStaged.stderr),
    'staged symlink whose target text holds a canary is rejected', String(linkStaged.status));
  git(dir, ['commit', '-q', '-m', 'bad link']);
  const linkChanged = runGuard(['--root', dir, '--changed-from', base4, '--patterns-file', patternsFile]);
  ok(linkChanged.status === 1 && /BLOCKED: bad-link contains/.test(linkChanged.stderr),
    'changed-from symlink whose target text holds a canary is rejected', String(linkChanged.status));
  git(dir, ['rm', '-q', 'bad-link']);
  git(dir, ['commit', '-q', '-m', 'drop bad link']);

  // Ordinary clean change, including a clean symlink, still passes both modes.
  const base3 = git(dir, ['rev-parse', 'HEAD']).trim();
  write(dir, 'docs/ok.md', 'ordinary clean documentation\n');
  fs.symlinkSync('docs/ok.md', path.join(dir, 'ok-link'));
  git(dir, ['add', '-A']);
  const okStaged = staged();
  ok(okStaged.status === 0, 'staged ordinary clean files pass', `${okStaged.status} ${okStaged.stderr}`);
  git(dir, ['commit', '-q', '-m', 'clean']);
  const okChanged = runGuard(['--root', dir, '--changed-from', base3, '--patterns-file', patternsFile]);
  ok(okChanged.status === 0, 'changed-from ordinary clean files pass', `${okChanged.status} ${okChanged.stderr}`);

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== merge queue: the required job re-scans the exact queue commit ===');
{
  ok(/\n  merge_group:\n    types: \[checks_requested\]\n/.test(workflowSrc), 'workflow runs on merge_group');
  ok(/group: privacy-guard-\$\{\{ github\.event\.pull_request\.number \|\| github\.event\.merge_group\.head_ref \}\}/.test(workflowSrc),
    'each merge group has its own concurrency group, so a queued run is never replaced');
  ok(/ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.event\.merge_group\.head_sha \}\}/.test(workflowSrc),
    'merge-queue incoming checkout is the queue commit');
  const stepIf = name => {
    const block = workflowSrc.split('- name: ' + name)[1] || '';
    const match = /^\s*if: (.*)$/m.exec(block.split('\n      - ')[0]);
    return match ? match[1].trim() : null;
  };
  ok(stepIf('Scan incoming files with the trusted guard') === 'always()',
    'the scan itself runs on every event (never skipped in the queue)');
  ok(stepIf('Mark the exact head pending') === "github.event_name == 'pull_request_target'"
    && stepIf('Publish exact-head status') === "always() && github.event_name == 'pull_request_target'",
    'PR-head commit statuses are written only for pull requests');

  // Execute the shipped scan step on a synthetic queue commit.
  const scanBlock = workflowSrc.split('- name: Scan incoming files with the trusted guard')[1]
    .split('\n      - name:')[0];
  const shell = scanBlock.split('        run: |\n')[1].split('\n')
    .map(line => line.replace(/^          /, '')).join('\n');
  const work = tmpDir();
  fs.symlinkSync(ROOT, path.join(work, 'trusted'));
  const incoming = initRepo();
  write(incoming, 'docs/note.md', 'base\n');
  const base = commit(incoming, 'base');
  write(incoming, 'docs/note.md', 'queued change\n');
  const clean = commit(incoming, 'queued');
  fs.symlinkSync(incoming, path.join(work, 'incoming'));
  const run = env => spawnSync('bash', ['-c', shell], { cwd: work, encoding: 'utf8',
    env: { ...process.env, RUNNER_TEMP: work, ATLAS_CI_DIAGNOSTICS_DIR: work, EVENT_NUMBER: '', ...env } });
  // A queue run has no PR number; it must still scan, and accept a clean write.
  ok(run({ EVENT_NAME: 'merge_group', EVENT_HEAD: clean, BASE_SHA: base }).status === 0,
    'merge_group scan accepts a clean queue commit');
  write(incoming, 'derived/leak.json', '{}\n');
  const leaky = commit(incoming, 'queued leak');
  ok(run({ EVENT_NAME: 'merge_group', EVENT_HEAD: leaky, BASE_SHA: base }).status !== 0,
    'merge_group scan rejects a queue commit that adds a derived/ file');
  ok(run({ EVENT_NAME: 'pull_request_target', EVENT_HEAD: clean, BASE_SHA: base }).status !== 0,
    'a pull_request_target run without a PR number still fails closed');
  ok(run({ EVENT_NAME: 'merge_group', EVENT_HEAD: '', BASE_SHA: base }).status !== 0,
    'merge_group without a head SHA fails closed');
  ok(run({ EVENT_NAME: 'merge_group', EVENT_HEAD: clean, BASE_SHA: '' }).status !== 0,
    'merge_group without a base SHA fails closed');
  ok(run({ EVENT_NAME: 'issue_comment', EVENT_NUMBER: '7', EVENT_HEAD: clean, BASE_SHA: base }).status !== 0,
    'an unsupported event fails closed');
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(incoming, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
