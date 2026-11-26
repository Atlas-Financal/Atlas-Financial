#!/usr/bin/env node
'use strict';
/* Approved demo asset digests: per-asset diff and refresh helper.
 *
 *   node scripts/demo-asset-digests.js [--check]  verify every prepared demo asset's
 *                                                 whole-file SHA-256 against
 *                                                 scripts/demo-asset-digests/;
 *                                                 exit 1 on any difference (default)
 *   node scripts/demo-asset-digests.js --write    verify privacy on every prepared demo
 *                                                 asset and rewrite only the differing
 *                                                 .sha256 files under scripts/demo-asset-digests/
 *
 * Uses scripts/package-demo.js (prepareAsset, checkDemoPrivacy) and
 * scripts/demo-server.js (ASSET_FILES, assetDigest, formatDigest, parseDigest)
 * directly; this file holds no second redactor or hash implementation.
 * CI never runs --write. Running --write does not replace reviewing the
 * prepared demo asset for privacy before committing.
 */
const fs = require('node:fs');
const path = require('node:path');
const {
  ASSET_FILES, FIXTURE_PATH, DIGESTS_REL,
  assetDigest, formatDigest, parseDigest, listDigestFiles,
} = require('./demo-server');
const { prepareAsset, checkDemoPrivacy } = require('./package-demo');

const ROOT = path.join(__dirname, '..');
const ASSET_FILE_SET = new Set(ASSET_FILES);
const HASH_RE = /^[0-9a-f]{64}$/;

const shortHash = hash => {
  if (hash == null) return '-';
  return HASH_RE.test(hash) ? hash.slice(0, 12) : 'invalid';
};

function readSource(root, name) {
  const source = path.join(root, name);
  if (fs.realpathSync(source) !== source) throw new Error('Unexpected demo file location');
  return fs.readFileSync(source);
}

function computeExpectedDigests(root, fingerprints) {
  const fixtureBytes = prepareAsset(FIXTURE_PATH, readSource(root, FIXTURE_PATH));
  checkDemoPrivacy(FIXTURE_PATH, fixtureBytes, fingerprints);
  const fixture = JSON.parse(fixtureBytes);
  const prepared = new Map([[FIXTURE_PATH, fixtureBytes]]);
  for (const name of ASSET_FILES) {
    if (prepared.has(name)) continue;
    const body = prepareAsset(name, readSource(root, name), fixture);
    checkDemoPrivacy(name, body, fingerprints);
    prepared.set(name, body);
  }
  const expected = new Map();
  for (const name of ASSET_FILES) {
    expected.set(name, assetDigest(prepared.get(name)));
  }
  return expected;
}

function readExistingDigests(digestsDir, { allowMalformedKnown = false } = {}) {
  const existing = new Map();
  const stale = [];
  if (!fs.existsSync(digestsDir)) return { existing, stale };
  for (const rel of listDigestFiles(digestsDir)) {
    if (!rel.endsWith('.sha256')) throw new Error(`Unexpected demo digest file: ${rel}`);
    const name = rel.slice(0, -'.sha256'.length);
    const raw = fs.readFileSync(path.join(digestsDir, rel), 'utf8');
    if (!ASSET_FILE_SET.has(name)) {
      let hash = null;
      try { hash = parseDigest(raw, rel); } catch { hash = 'invalid'; }
      stale.push({ name, rel, hash });
      continue;
    }
    let hash;
    try {
      hash = parseDigest(raw, rel);
    } catch (error) {
      if (!allowMalformedKnown) throw error;
      hash = 'invalid';
    }
    existing.set(name, hash);
  }
  return { existing, stale };
}

function diffDigests(existing, stale, expected) {
  const rows = [];
  for (const name of ASSET_FILES) {
    const oldHash = existing.has(name) ? existing.get(name) : null;
    const newHash = expected.get(name);
    if (oldHash === newHash) continue;
    rows.push({
      change: oldHash === null ? 'added' : 'changed',
      name,
      oldHash,
      newHash,
    });
  }
  for (const entry of stale) {
    rows.push({
      change: 'removed',
      name: entry.name,
      rel: entry.rel,
      oldHash: entry.hash,
      newHash: null,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function formatDiff(rows) {
  return rows.map(row =>
    `${row.change.toUpperCase().padEnd(7)}  ${row.name}  ${shortHash(row.oldHash)} -> ${shortHash(row.newHash)}`
  ).join('\n');
}

function writeDigests(digestsDir, rows) {
  const touched = [];
  for (const row of rows) {
    if (row.change === 'removed') {
      const target = path.join(digestsDir, row.rel);
      fs.rmSync(target);
      touched.push(row.rel);
      for (let dir = path.dirname(target);
        dir.startsWith(digestsDir) && dir !== digestsDir && !fs.readdirSync(dir).length;
        dir = path.dirname(dir)) {
        fs.rmdirSync(dir);
      }
      continue;
    }
    const rel = row.name + '.sha256';
    const target = path.join(digestsDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, formatDigest(row.newHash));
    touched.push(rel);
  }
  return touched.sort();
}

function main(argv, deps = {}, log = console.log) {
  const write = argv.includes('--write');
  if (argv.length > 1 || (argv.length && !['--check', '--write'].includes(argv[0]))) {
    log('Usage: node scripts/demo-asset-digests.js [--check|--write]');
    return 2;
  }
  const root = fs.realpathSync(path.resolve(deps.root || ROOT));
  const digestsDir = path.join(root, DIGESTS_REL);
  const expected = computeExpectedDigests(root, deps.fingerprints);
  const { existing, stale } = readExistingDigests(digestsDir, { allowMalformedKnown: write });
  const rows = diffDigests(existing, stale, expected);
  if (!rows.length) {
    log('Demo asset digests: no differences from scripts/demo-asset-digests/.');
    return 0;
  }
  log(`Demo asset digests: differences.\n${formatDiff(rows)}`);
  if (!write) return 1;
  const touched = writeDigests(digestsDir, rows);
  log(`\nWrote ${touched.length} file${touched.length === 1 ? '' : 's'} under ${DIGESTS_REL}/: ${rows.map(r => r.name).join(', ')}.`);
  log('Review the prepared demo asset diff before committing; --write does not discharge the privacy review.');
  return 0;
}

module.exports = {
  main,
  computeExpectedDigests,
  readExistingDigests,
  diffDigests,
  formatDiff,
  writeDigests,
};

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    process.exitCode = 2;
  }
}
