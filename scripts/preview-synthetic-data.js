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

// The real path of a location that may not exist yet: resolve the nearest
// existing ancestor through any symlink or junction, then re-append the rest.
function realLocation(target) {
  let existing = target;
  const rest = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync.native(existing), ...rest);
}

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// The stage directory is a throwaway copy. Refuse anything inside the
// repository, where the canonical data.json and public/ aggregates live,
// including a path that only reaches it through a symlink or junction.
function assertStageDir(stageDir) {
  if (!stageDir) throw new Error('usage: preview-synthetic-data.js <stage-dir>');
  const stage = path.resolve(stageDir);
  const realRoot = fs.realpathSync.native(ROOT);
  if (inside(ROOT, stage) || inside(realRoot, realLocation(stage))) {
    throw new Error('refusing to stage preview data inside the repository: ' + stage);
  }
  return stage;
}

function writeSyntheticData(stageDir) {
  const stage = assertStageDir(stageDir);
  fs.mkdirSync(stage, { recursive: true });
  const file = path.join(stage, 'data.json');
  // Re-check after mkdir: the stage (or a data.json already in it) must not
  // resolve into the repository.
  // A link in place of data.json (even a dangling one) could write anywhere.
  let linked = false;
  try { linked = fs.lstatSync(file).isSymbolicLink(); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (linked) throw new Error('refusing to write preview data through a link: ' + file);
  const realRoot = fs.realpathSync.native(ROOT);
  if (inside(realRoot, realLocation(file))) {
    throw new Error('refusing to stage preview data inside the repository: ' + file);
  }
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
