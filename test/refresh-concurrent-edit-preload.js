'use strict';
/* Test-only preload (node -r) for the canonical-refresh compare-and-swap
 * proof (A12). It simulates an owner editing data.json while the refresh
 * CLI is awaiting its provider fetch: the first time the CLI reads the
 * --fixture payload (inside loadPayload, after data.json was loaded), this
 * hook rewrites the temp data.json with an invented owner edit — an owner
 * instruction note plus an invented $200 bill. It never touches a real
 * file: the target path comes from ATLAS_TEST_CONCURRENT_EDIT and the
 * tests point it at a temp directory only.
 */
const fs = require('fs');
const path = require('path');

const spec = JSON.parse(process.env.ATLAS_TEST_CONCURRENT_EDIT || 'null');
if (spec && spec.fixture && spec.data) {
  const fixture = path.resolve(spec.fixture);
  const dataPath = path.resolve(spec.data);
  const realRead = fs.readFileSync;
  let fired = false;
  fs.readFileSync = function concurrentOwnerEdit(file, ...rest) {
    if (!fired && typeof file === 'string' && path.resolve(file) === fixture) {
      fired = true;
      const doc = JSON.parse(realRead.call(fs, dataPath, 'utf8'));
      doc.meta = Object.assign({}, doc.meta, { ownerInstruction: 'INVENTED concurrent owner instruction' });
      doc.plan = doc.plan || {};
      doc.plan.bills = Array.isArray(doc.plan.bills) ? doc.plan.bills : [];
      doc.plan.bills.push({ id: 'invented-concurrent-bill', name: 'Invented concurrent bill', amount: 200 });
      fs.writeFileSync(dataPath, `${JSON.stringify(doc, null, 2)}\n`);
    }
    return realRead.call(fs, file, ...rest);
  };
}

// Runner used by the writer suites: run the real CLI with this preload so
// the owner edit lands mid-fetch, then report what survived on disk.
function runWithConcurrentOwnerEdit(args, fixturePath, dataPath) {
  const { spawnSync } = require('child_process');
  const ROOT = path.join(__dirname, '..');
  const res = spawnSync(process.execPath, [
    '-r', __filename,
    path.join(ROOT, 'scripts', 'canonical-refresh.js'),
  ].concat(args), {
    cwd: ROOT,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      ATLAS_TEST_CONCURRENT_EDIT: JSON.stringify({ fixture: fixturePath, data: dataPath }),
    }),
  });
  const after = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const ownerEditSurvived = !!(after.meta && after.meta.ownerInstruction === 'INVENTED concurrent owner instruction')
    && !!(after.plan && Array.isArray(after.plan.bills)
      && after.plan.bills.some(b => b && b.id === 'invented-concurrent-bill' && Number(b.amount) === 200));
  return {
    code: res.status == null ? 1 : res.status,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || ''),
    after,
    ownerEditSurvived,
    refusedAsChanged: /changed since it was loaded/.test(String(res.stderr || '')),
  };
}

module.exports = { runWithConcurrentOwnerEdit };
