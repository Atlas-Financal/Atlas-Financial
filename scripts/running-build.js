'use strict';
// Non-secret build provenance, never a financial store. npm ci captures only
// the checked-out commit's identity; the server accepts it only for that exact
// deployed SHA. No GitHub request, ancestor search, or latest-PR inference.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const FILE = '.atlas-build.json';
const SCHEMA = 'atlas-build/v1';
const FULL_SHA = /^[0-9a-f]{40}$/i;
const PR = '[1-9][0-9]{0,8}';

function fromGit(root) {
  try {
    const options = {
      cwd: root, timeout: 1500, maxBuffer: 32768,
      env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    };
    const record = execFileSync('git', ['show', '-s', '--no-notes',
      '--format=%H%x00%s%x00%b', 'HEAD'], options);
    const [gitSha, subject, rawBody] = record.split('\0');
    if (!FULL_SHA.test(gitSha) || rawBody === undefined) return null;
    const body = rawBody.replace(/\n+$/, '');
    const merge = new RegExp(`^Merge pull request #(${PR}) from (?:tc5v5s64ym-sketch|Atlas-Financal)/[A-Za-z0-9_./-]+$`)
      .exec(subject);
    // Pretty-format %P hides parents at a shallow boundary. The exact commit
    // object retains them without fetching ancestors or consulting a provider.
    const headers = execFileSync('git', ['cat-file', 'commit', gitSha], options).split('\n\n')[0];
    const parentIds = headers.split('\n').filter(line => line.startsWith('parent '))
      .map(line => line.slice(7));
    const mergePr = merge && parentIds.length === 2 && parentIds.every(id => FULL_SHA.test(id))
      ? Number(merge[1]) : null;
    // Linear/squash/rebase history needs an explicit final trailer. A generic
    // "(#123)" subject can be an issue reference and does not establish a PR.
    const trailers = body.match(/^Atlas-PR:.*$/gm) || [];
    const trailer = new RegExp(`(?:^|\n)Atlas-PR: (${PR})\n?$`).exec(body);
    const trailerPr = trailers.length === 1 && trailer ? Number(trailer[1]) : null;
    const conflicting = trailers.length > 0 && (!trailerPr || (mergePr && mergePr !== trailerPr));
    const prNumber = conflicting ? null : mergePr || trailerPr;
    return { schema: SCHEMA, gitSha: gitSha.toLowerCase(), prNumber,
      prSource: prNumber ? (mergePr ? 'git-merge-subject' : 'git-pr-trailer') : null };
  } catch { return null; }
}

function valid(record, gitSha) {
  return record && record.schema === SCHEMA && typeof record.gitSha === 'string' && FULL_SHA.test(record.gitSha)
    && record.gitSha.toLowerCase() === gitSha.toLowerCase()
    && Number.isInteger(record.prNumber) && record.prNumber > 0 && record.prNumber <= 999999999
    && ['git-merge-subject', 'git-pr-trailer'].includes(record.prSource);
}

function label(root, gitSha) {
  if (typeof gitSha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(gitSha)) return 'Running build unavailable';
  let built;
  try {
    const file = path.join(root, FILE);
    if (fs.statSync(file).size <= 1024) built = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* unavailable build artifact */ }
  const record = valid(built, gitSha) ? built : fromGit(root);
  return valid(record, gitSha)
    ? `Running PR #${record.prNumber} · ${gitSha.slice(0, 7)}`
    : `Running commit ${gitSha.slice(0, 7)}`;
}

function capture(root) {
  // Always overwrite: a reused build cache must not retain an older PR claim.
  const record = fromGit(root) || { schema: SCHEMA, gitSha: null, prNumber: null, prSource: null };
  fs.writeFileSync(path.join(root, FILE), JSON.stringify(record) + '\n');
  return record;
}

if (require.main === module) capture(path.join(__dirname, '..'));
module.exports = { fromGit, label, capture, FILE };
