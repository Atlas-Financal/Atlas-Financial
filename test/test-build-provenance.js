'use strict';
// Real synthetic Git history: independently known PR identity on exact commits.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Build = require('../scripts/running-build');

function makeHistory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-build-history-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8',
    env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Synthetic test');
  git('config', 'user.email', 'synthetic@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  const commit = message => { git('commit', '--allow-empty', '-m', message); return git('rev-parse', 'HEAD'); };
  commit('Synthetic base');
  git('checkout', '-b', 'feature'); commit('Synthetic feature');
  git('checkout', 'main'); commit('Synthetic independent main');
  git('merge', '--no-ff', 'feature', '-m',
    'Merge pull request #27 from tc5v5s64ym-sketch/agent/synthetic-feature');
  const merge = git('rev-parse', 'HEAD');
  const direct = commit('Follow-up mentions #28 but is not a merge');
  const squash = commit('Synthetic squash\n\nAtlas-PR: 28');
  const rebase = commit('Synthetic rebased terminal commit\n\nAtlas-PR: 29');
  git('checkout', '-b', 'org-feature'); commit('Synthetic org feature');
  git('checkout', 'main'); commit('Synthetic independent main after transfer');
  git('merge', '--no-ff', 'org-feature', '-m',
    'Merge pull request #40 from Atlas-Financal/agent/synthetic-org-feature');
  const orgMerge = git('rev-parse', 'HEAD');
  return { root, git, commit, merge, direct, squash, rebase, orgMerge };
}

function main() {
  const h = makeHistory();
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-build-no-git-'));
  try {
    // Build hosts can retain only HEAD. Pretty-format %P then hides parents,
    // although the exact merge commit object still records both of them.
    h.git('checkout', '--detach', h.merge);
    const shallow = path.join(missing, 'shallow');
    execFileSync('git', ['clone', '--depth=1', '--no-tags', `file://${h.root}`, shallow], {
      env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const shallowGit = (...args) => execFileSync('git', args, {
      cwd: shallow, env: { PATH: process.env.PATH }, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    assert.equal(shallowGit('rev-parse', '--is-shallow-repository'), 'true');
    assert.equal(shallowGit('rev-parse', 'HEAD'), h.merge);
    assert.equal(shallowGit('show', '-s', '--format=%P', 'HEAD'), '');
    assert.equal(shallowGit('cat-file', 'commit', 'HEAD').split('\n\n')[0]
      .split('\n').filter(line => line.startsWith('parent ')).length, 2);
    const shallowRecord = Build.capture(shallow);
    assert.equal(shallowRecord.gitSha, h.merge);
    assert.equal(shallowRecord.prNumber, 27, 'a shallow merge must retain exact-commit PR provenance');
    assert.equal(shallowRecord.prSource, 'git-merge-subject');
    assert.equal(Build.label(shallow, h.merge), `Running PR #27 · ${h.merge.slice(0, 7)}`);
    fs.copyFileSync(path.join(shallow, Build.FILE), path.join(missing, Build.FILE));
    assert.equal(Build.label(missing, h.merge), `Running PR #27 · ${h.merge.slice(0, 7)}`,
      'shallow install provenance remains usable without Git at runtime');
    assert.equal(Build.label(missing, h.direct), `Running commit ${h.direct.slice(0, 7)}`);
    for (const [sha, pr, source] of [[h.merge, 27, 'git-merge-subject'],
      [h.squash, 28, 'git-pr-trailer'], [h.rebase, 29, 'git-pr-trailer']]) {
      h.git('checkout', '--detach', sha);
      const record = Build.capture(h.root);
      assert.equal(record.gitSha, sha);
      assert.equal(record.prNumber, pr);
      assert.equal(record.prSource, source);
      assert.equal(Build.label(h.root, sha), `Running PR #${pr} · ${sha.slice(0, 7)}`);
      // A deployment need not retain .git. The captured artifact is enough,
      // but only for exactly the SHA serving the HTML.
      fs.copyFileSync(path.join(h.root, Build.FILE), path.join(missing, Build.FILE));
      assert.equal(Build.label(missing, sha), `Running PR #${pr} · ${sha.slice(0, 7)}`);
      assert.equal(Build.label(missing, h.direct), `Running commit ${h.direct.slice(0, 7)}`);
      assert.equal(Build.label(missing, sha.slice(0, 7)), `Running commit ${sha.slice(0, 7)}`);
    }
    h.git('checkout', '--detach', h.orgMerge);
    const orgRecord = Build.capture(h.root);
    assert.equal(orgRecord.prNumber, 40, 'a post-transfer org merge must retain exact-commit PR provenance');
    assert.equal(orgRecord.prSource, 'git-merge-subject');
    assert.equal(Build.label(h.root, h.orgMerge), `Running PR #40 · ${h.orgMerge.slice(0, 7)}`);
    h.git('checkout', '--detach', h.direct);
    assert.equal(Build.label(h.root, h.direct), `Running commit ${h.direct.slice(0, 7)}`,
      'a new direct commit does not inherit an ancestor PR or a cached artifact');
    assert.equal(Build.capture(h.root).prNumber, null, 'capture overwrites the previous PR');
    for (const message of [
      'Synthetic issue fix (#30)',
      'Merge pull request #31 from tc5v5s64ym-sketch/agent/one-parent',
      'Unmarked rebased commit',
      'Ambiguous trailers\n\nAtlas-PR: 32\nAtlas-PR: 33',
      'Not a final trailer\n\nAtlas-PR: 34\nMore prose',
      'Invalid trailer\n\nAtlas-PR: 0',
      'Invalid trailer\n\nAtlas-PR: <script>unsafe</script>',
    ]) {
      const sha = h.commit(message);
      assert.equal(Build.capture(h.root).prNumber, null, message);
      assert.equal(Build.label(h.root, sha), `Running commit ${sha.slice(0, 7)}`);
    }
    h.git('checkout', '--detach', h.merge);
    h.git('commit', '--amend', '-m',
      'Merge pull request #27 from tc5v5s64ym-sketch/agent/synthetic-feature\n\nAtlas-PR: 35');
    assert.equal(Build.capture(h.root).prNumber, null, 'conflicting exact-commit claims fail closed');
    const sha = h.git('rev-parse', 'HEAD');
    for (const record of [
      '{bad json',
      JSON.stringify({ schema: 'other/v1', gitSha: sha, prNumber: 36, prSource: 'git-pr-trailer' }),
      JSON.stringify({ schema: 'atlas-build/v1', gitSha: sha, prNumber: '36', prSource: 'git-pr-trailer' }),
      JSON.stringify({ schema: 'atlas-build/v1', gitSha: sha, prNumber: 36, prSource: 'latest-github-pr' }),
      JSON.stringify({ schema: 'atlas-build/v1', gitSha: [sha], prNumber: 36, prSource: 'git-pr-trailer' }),
      JSON.stringify({ schema: 'atlas-build/v1', gitSha: null, prNumber: 36, prSource: 'git-pr-trailer' }),
      'x'.repeat(1025),
    ]) {
      fs.writeFileSync(path.join(missing, Build.FILE), record);
      assert.equal(Build.label(missing, sha), `Running commit ${sha.slice(0, 7)}`);
    }
    assert.equal(Build.label(missing, null), 'Running build unavailable');
    assert.equal(Build.label(missing, [sha]), 'Running build unavailable');
    assert.equal(Build.label(missing, '<script>unsafe</script>'), 'Running build unavailable');
    assert.equal(Build.capture(missing).gitSha, null, 'no Git clears old cached provenance');
    const pkg = require('../package.json');
    assert.equal(pkg.scripts.postinstall, 'node scripts/running-build.js', 'npm ci integrates capture');
    console.log('PASS exact Git merge/trailer provenance including shallow merge capture, squash/rebase/direct fallback, stale/unknown/malformed metadata, artifact without Git, install integration');
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
    fs.rmSync(missing, { recursive: true, force: true });
  }
}
if (require.main === module) main();
module.exports = { makeHistory };
