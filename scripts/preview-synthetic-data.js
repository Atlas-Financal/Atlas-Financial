'use strict';
// Write the invented Budget-surface household as the dev preview's data.json.
//
// scripts/preview.ps1 serves a static, unauthenticated copy of the site. It
// must never serve household figures, so it stages only this invented
// packet (test/fixtures/budget-surface-data.js, served through the real
// observation and overlay) and never the canonical data.json or any other
// published JSON aggregate. A developer who needs real data locally asks the
// owner; that is not this script's job.
//
//   node scripts/preview-synthetic-data.js <stage-dir>
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Household JSON the build must never open: the canonical data.json and any
// published aggregate in public/. Building the invented packet runs the real
// overlay, whose operating answer looks for public/periods.json; the packet
// does not depend on it, so while it builds those files read as absent.
function isHouseholdJson(file) {
  const full = path.resolve(String(file));
  if (full === path.join(ROOT, 'data.json')) return true;
  return path.dirname(full) === path.join(ROOT, 'public') && /\.json$/i.test(full);
}

function syntheticPacket() {
  const exists = fs.existsSync;
  const read = fs.readFileSync;
  fs.existsSync = function (file, ...rest) {
    return isHouseholdJson(file) ? false : exists.call(fs, file, ...rest);
  };
  fs.readFileSync = function (file, ...rest) {
    if (typeof file !== 'number' && isHouseholdJson(file)) {
      const err = new Error('preview staging never reads household JSON');
      err.code = 'ENOENT';
      throw err;
    }
    return read.call(fs, file, ...rest);
  };
  try {
    return require('../test/fixtures/budget-surface-data').served();
  } finally {
    fs.existsSync = exists;
    fs.readFileSync = read;
  }
}

// The stage directory is a throwaway copy. Refuse anything inside the
// repository, where the canonical data.json and public/ aggregates live.
function assertStageDir(stageDir) {
  if (!stageDir) throw new Error('usage: preview-synthetic-data.js <stage-dir>');
  const stage = path.resolve(stageDir);
  const rel = path.relative(ROOT, stage);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error('refusing to stage preview data inside the repository: ' + stage);
  }
  return stage;
}

function writeSyntheticData(stageDir) {
  const stage = assertStageDir(stageDir);
  fs.mkdirSync(stage, { recursive: true });
  const file = path.join(stage, 'data.json');
  fs.writeFileSync(file, JSON.stringify(syntheticPacket()));
  return file;
}

if (require.main === module) {
  try {
    process.stdout.write(writeSyntheticData(process.argv[2]) + '\n');
  } catch (err) {
    process.stderr.write(String(err && err.message || err) + '\n');
    process.exit(1);
  }
}

module.exports = { syntheticPacket, assertStageDir, writeSyntheticData, isHouseholdJson };
