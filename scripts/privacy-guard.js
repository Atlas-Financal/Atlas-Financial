'use strict';
/* Sole raw-data / identifier / secret guard.
 *
 * Local commits invoke this from `.githooks/pre-commit`. CI invokes the
 * trusted default-branch copy against an incoming write. Do not copy
 * CONTENT_PATTERNS into another file — a second list is a second policy.
 *
 * CLI:
 *   --staged                         scan the git index (local hook)
 *   --root <dir> --changed-from SHA  scan every commit on SHA..HEAD: each file
 *                                    version a commit records, read from git,
 *                                    not only the net SHA...HEAD diff
 *   --patterns-file <path>           test-only synthetic patterns; CI must not
 *
 * A symlink's recorded content is its target text. That text is scanned for
 * content like any file, and the place it points to is judged by the path
 * policy: a link into raw/ or derived/, at a statement or a .pdf, at the
 * repository root, or outside the repository is rejected. The link is never
 * followed.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Incumbent content policy, moved here from `.githooks/pre-commit` so the
// hook and CI share one list. Household identifiers stay in this file only.
const CONTENT_PATTERNS = "NAUDI|CUTLER PL|V2X8R1|dnaudi@|privaterelay\\.appleid|6355425|6012135|6353074|1650429|3225135|9107573|9107595|452005|5446 ?12|14J2W4V|214JL|SITE_PASSWORD *= *[\"']|SESSION_SECRET *= *[\"']|LUNCHMONEY_ACCESS_TOKEN *= *[\"']|ATLAS_PROVIDER_ACCOUNT_MAP_JSON *= *[\"']|ATLAS_ASSISTANT_TOKEN *= *[\"']|ATLAS_TALK_GEMINI_API_KEY *= *[\"']";

const PATH_BLOCK_RE = /^(raw|derived)\/|\.pdf$|^statements/i;
const SKIP_CONTENT_RE = /^scripts\/privacy-guard\.js$/;
const EXCERPT_LEN = 110;

function parseArgs(argv) {
  const out = {
    staged: false,
    root: process.cwd(),
    changedFrom: '',
    patternsFile: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--staged') out.staged = true;
    else if (arg === '--root') out.root = argv[++i];
    else if (arg === '--changed-from') out.changedFrom = argv[++i];
    else if (arg === '--patterns-file') out.patternsFile = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.root) throw new Error('missing --root');
  if (out.staged && out.changedFrom) throw new Error('use --staged or --changed-from, not both');
  if (!out.staged && !out.changedFrom) throw new Error('missing --staged or --changed-from');
  return out;
}

function loadPatterns(patternsFile) {
  if (!patternsFile) return CONTENT_PATTERNS;
  const body = fs.readFileSync(patternsFile, 'utf8');
  const line = body.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!line) throw new Error(`patterns file is empty: ${patternsFile}`);
  return line;
}

// Git output is buffered in memory. Node's default maxBuffer (~1 MB) is
// smaller than files this repository already tracks, so it is raised to a
// fixed bound. Anything larger still throws, and an unreadable file fails
// closed (see scanFiles), so the bound limits what may be committed, never
// what may skip the scan.
const MAX_READ_BYTES = 256 * 1024 * 1024;

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_READ_BYTES,
  });
}

// Every status that can carry content into the result: lowercase `d`
// excludes only deletions, so type changes (T), unmerged (U), unknown (X)
// and any status git adds later are scanned rather than silently omitted.
const DIFF_FILTER = '--diff-filter=d';
const SYMLINK_MODE = '120000';
const SHA_RE = /^[0-9a-f]{40}$/i;

// Git quotes unusual pathnames unless -z is used. A quoted name handed to
// git would miss the real file and skip its content.
function splitNul(out) {
  return String(out).split('\0').filter((s) => s.length > 0);
}

// Parse `--raw -z` output with renames off: each record is
// ":<old mode> <new mode> <old oid> <new oid> <status>" then one path.
// A record that does not parse is a failure, never a skip.
function parseRaw(out) {
  const parts = splitNul(out);
  const entries = [];
  for (let i = 0; i < parts.length; i += 2) {
    const meta = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/i.exec(parts[i]);
    const file = parts[i + 1];
    if (!meta || file == null) throw new Error('could not parse git raw diff output');
    entries.push({ file, mode: meta[2], oid: meta[4] });
  }
  return entries;
}

function listStaged(root) {
  const out = git(root, ['diff', '-z', '--cached', '--raw', '--no-renames', '--no-abbrev', DIFF_FILTER]);
  return parseRaw(out);
}

// Every commit the write adds (reachable from HEAD, not from the base), and
// for each one every file version it records against each of its parents.
// A file added in one commit and deleted in a later one never appears in the
// net diff, but its content is in the history that merges.
function listChanged(root, fromSha) {
  if (!SHA_RE.test(String(fromSha || ''))) {
    throw new Error('changed-from must be a 40-character SHA');
  }
  const commits = git(root, ['rev-list', '--reverse', `${fromSha}..HEAD`])
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const entries = [];
  const seen = new Set();
  for (const commit of commits) {
    if (!SHA_RE.test(commit)) throw new Error('could not list the commits to scan');
    const out = git(root, ['diff-tree', '-z', '-r', '-m', '--root', '--raw', '--no-renames',
      '--no-abbrev', '--no-commit-id', DIFF_FILTER, commit]);
    for (const entry of parseRaw(out)) {
      const key = `${entry.mode} ${entry.oid} ${entry.file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ ...entry, commit });
    }
  }
  return entries;
}

// Returns the blob git recorded, or null when it cannot be read. null is
// never "nothing to scan": scanFiles turns it into a finding.
function readBlob(root, oid) {
  try {
    if (!/^[0-9a-f]{40,64}$/i.test(String(oid)) || /^0+$/.test(oid)) return null;
    return git(root, ['cat-file', 'blob', oid]);
  } catch {
    return null;
  }
}

// Where a symlink points, as a repository-relative path, or null when it
// points at the repository root or outside the repository. The link is not
// followed; this is string resolution of the recorded target only.
function symlinkTarget(file, target) {
  const text = String(target);
  if (!text || text.includes('\0') || path.posix.isAbsolute(text) || /^[a-z]:/i.test(text)
      || text.includes('\\')) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), text));
  if (resolved === '.' || resolved === '..' || resolved.startsWith('../')) return null;
  return resolved.replace(/\/+$/, '');
}

function symlinkBlocked(file, target) {
  const resolved = symlinkTarget(file, target);
  return resolved == null || PATH_BLOCK_RE.test(resolved) || PATH_BLOCK_RE.test(`${resolved}/`);
}

function contentHits(body, patterns) {
  const re = new RegExp(patterns, 'i');
  const hits = [];
  const lines = String(body).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      hits.push({ line: i + 1, excerpt: lines[i].slice(0, EXCERPT_LEN) });
      if (hits.length >= 5) break;
    }
  }
  return hits;
}

// `files` holds plain path strings, or entries { file, mode, commit } from
// the git listings. readFile receives the entry and returns its content.
function scanFiles({ files, patterns, readFile }) {
  const findings = [];
  for (const item of files) {
    const entry = typeof item === 'string' ? { file: item } : item;
    const { file } = entry;
    const where = entry.commit ? { commit: entry.commit } : {};
    if (PATH_BLOCK_RE.test(file)) {
      findings.push({ file, kind: 'path', ...where });
      continue;
    }
    if (SKIP_CONTENT_RE.test(file) && entry.mode !== SYMLINK_MODE) continue;
    const body = readFile(typeof item === 'string' ? file : entry);
    if (body == null) {
      findings.push({ file, kind: 'unreadable', ...where });
      continue;
    }
    if (entry.mode === SYMLINK_MODE && symlinkBlocked(file, body)) {
      findings.push({ file, kind: 'symlink', target: String(body).slice(0, EXCERPT_LEN), ...where });
    }
    for (const hit of contentHits(body, patterns)) {
      findings.push({ file, kind: 'content', line: hit.line, excerpt: hit.excerpt, ...where });
    }
  }
  return findings;
}

function report(findings, stream = process.stderr) {
  const at = (f) => (f.commit ? ` (commit ${f.commit.slice(0, 12)})` : '');
  const paths = findings.filter((f) => f.kind === 'path');
  const content = findings.filter((f) => f.kind === 'content');
  const unreadable = findings.filter((f) => f.kind === 'unreadable');
  const links = findings.filter((f) => f.kind === 'symlink');
  if (unreadable.length) {
    stream.write('\nBLOCKED: privacy guard could not read these files, so it failed closed.\n');
    for (const f of unreadable) stream.write(`  ${f.file}${at(f)}\n`);
  }
  if (paths.length) {
    stream.write('\nBLOCKED: raw financial data must never be committed.\n');
    for (const f of paths) stream.write(`  ${f.file}${at(f)}\n`);
  }
  if (links.length) {
    stream.write('\nBLOCKED: a symlink points at raw data, the repository root, or outside the repository.\n');
    for (const f of links) stream.write(`  ${f.file}${at(f)}\n`);
  }
  const byFile = new Map();
  for (const f of content) {
    const key = `${f.file}${at(f)}`;
    if (!byFile.has(key)) byFile.set(key, { file: f.file, where: at(f), hits: [] });
    byFile.get(key).hits.push(f);
  }
  for (const { file, where, hits } of byFile.values()) {
    stream.write(`\nBLOCKED: ${file} contains a personal identifier or secret${where}.\n`);
    for (const hit of hits) stream.write(`  ${hit.line}:${hit.excerpt}\n`);
  }
  if (findings.length) {
    stream.write('\nNothing was committed. Remove the offending content, or move the file\n');
    stream.write('into raw/ or derived/ where it stays local.\n\n');
  }
}

function main(argv) {
  const args = parseArgs(argv);
  const root = path.resolve(args.root);
  const patterns = loadPatterns(args.patternsFile);
  const files = args.staged ? listStaged(root) : listChanged(root, args.changedFrom);
  // One blob can appear under many commits; read it once.
  const blobs = new Map();
  const readFile = (entry) => {
    if (!blobs.has(entry.oid)) blobs.set(entry.oid, readBlob(root, entry.oid));
    return blobs.get(entry.oid);
  };
  const findings = scanFiles({ files, patterns, readFile });
  report(findings);
  return findings.length === 0 ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`privacy-guard failed closed: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  }
}

module.exports = {
  CONTENT_PATTERNS,
  PATH_BLOCK_RE,
  SKIP_CONTENT_RE,
  MAX_READ_BYTES,
  parseArgs,
  loadPatterns,
  scanFiles,
  listStaged,
  listChanged,
  symlinkTarget,
  symlinkBlocked,
  main,
};
