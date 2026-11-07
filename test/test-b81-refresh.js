'use strict';
/* B81 / AF-LIVE-02 — earned preview → approve → bounded canonical write.
 *
 * Proves the mechanism on fixtures. Does not apply the unused Chequing B
 * $10 to live data.json. Does not choose a Triangle same-day winner.
 * Does not invent a real pending→posted case.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const O = require('../scripts/provider-observe.js');
const C = require('../scripts/canonical-refresh.js');
const Forecast = require('../public/forecast.js');
const { independentSpendableOpening } = require('./test-helpers');

const ROOT = path.join(__dirname, '..');
const LIVE_DATA = path.join(ROOT, 'data.json');
const FIXTURE = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'lunchmoney-b81-refresh.json');
const MAP = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'b81-account-map.json');
const IDENTITY = path.join(ROOT, 'docs', 'connectivity', 'transaction-identity.json');
const SCRIPT = path.join(ROOT, 'scripts', 'canonical-refresh.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const clone = x => JSON.parse(JSON.stringify(x));

const liveData = JSON.parse(execFileSync('git', ['show', '28d08a12:data.json'], { encoding: 'utf8' }));
const payload = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const accountMap = JSON.parse(fs.readFileSync(MAP, 'utf8'));
const identity = JSON.parse(fs.readFileSync(IDENTITY, 'utf8'));
const liveHash = hashFile(LIVE_DATA);

function previewAt(data, extraPayload) {
  return C.previewFrom({
    provider: 'lunchmoney',
    payload: extraPayload || payload,
    accountMap,
    data,
    identity,
    fetchedAt: (extraPayload || payload).fetchedAt,
  });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-b81-'));
}

function writeTempData(dir, data) {
  const dest = path.join(dir, 'data.json');
  fs.writeFileSync(dest, `${JSON.stringify(data, null, 4)}\n`);
  return dest;
}

function runCli(args, extra) {
  const opts = Object.assign({
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }, extra || {});
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT].concat(args), opts);
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: err.status == null ? 1 : err.status,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || ''),
    };
  }
}

console.log('=== A. default preview is deterministic and non-writing ===');
{
  const first = previewAt(liveData);
  const second = previewAt(liveData);
  ok(first.preview.writesCanonicalState === false, 'preview does not claim a write');
  ok(first.preview.canonicalWriteAuthorized === false, 'preview is not an approval');
  ok(first.preview.unattended === false && first.preview.productionWrite === false,
    'preview is not unattended production');
  ok(first.preview.previewId === second.preview.previewId, 'second preview is the same previewId');
  ok(JSON.stringify(first.preview.proposed) === JSON.stringify(second.preview.proposed),
    'proposed change set is byte-stable');
  ok(C.identityProofLooksSanitized(first.preview),
    'preview omits provider IDs, transaction IDs, and the token name');
  ok(hashFile(LIVE_DATA) === liveHash, 'live data.json is unchanged by preview');
}

console.log('\n=== B. only the justified Chequing B posted change is proposed ===');
{
  const { preview } = previewAt(liveData);
  ok(preview.proposed.length === 1, 'exactly one field is proposed',
    `${preview.proposed.length} proposed`);
  const change = preview.proposed[0];
  ok(change && change.locator === 'cash:chequing-b', 'the proposed locator is cash:chequing-b');
  ok(change && near(change.currentValue, 932.05), 'preview shows the live $932.05');
  ok(change && near(change.proposedValue, 922.05), 'preview shows the fixture $922.05');
  ok(change && change.evidenceDate === '2026-08-17', 'preview carries the evidence date');
  ok(change && change.source === 'provider-observe:lunchmoney', 'preview names the observe source');
  ok(change && /CHANGE/.test(change.reason), 'preview states the reconcile reason');
}

console.log('\n=== C. fail-closed refusals stay refused ===');
{
  const { preview, report } = previewAt(liveData);
  const reasons = preview.refused.map(r => r.reason);
  const locators = preview.refused.map(r => r.locator);
  ok(reasons.includes('unmapped-provider-account'), 'unmapped accounts are refused');
  ok(preview.unmappedCount >= 2, 'DEBT&PAYMENTS / SAVINGS-DONT TOUCH / extra stay unmapped',
    String(preview.unmappedCount));
  ok(reasons.includes('same-day-no-winner'), 'same-day Triangle CHANGE is refused');
  ok(locators.includes('debts:triangle'), 'Triangle is the same-day refusal');
  ok(reasons.includes('stale-not-current'), 'older savings evidence is refused');
  ok(locators.includes('cash:savings'), 'stale refusal is cash:savings');
  ok(reasons.includes('credit-capacity-not-cash'), 'available credit is not cash');
  ok(reasons.includes('unresolved-pending'), 'unresolved pending cannot write');
  ok(reasons.includes('historical-opening-backfill'),
    'historical payroll cannot backfill representedEvents');
  ok(preview.cardCapacityIsCash === 0, 'cardCapacityIsCash is independently 0');
  ok(report.writesCanonicalState === false, 'observer still does not write');
  const opening = liveData.plan.opening.representedEvents || [];
  ok((opening || []).length === 0,
    'pinned historical opening representedEvents stay empty');
  ok(!preview.proposed.some(p => p.locator === 'cash:savings'),
    'stale savings is not in the proposed set');
  ok(!preview.proposed.some(p => p.locator === 'debts:triangle'),
    'Triangle is not in the proposed set');
}

console.log('\n=== D. rejected or unapproved preview leaves bytes identical ===');
{
  const dir = tempDir();
  const dest = writeTempData(dir, liveData);
  const before = hashFile(dest);
  const { preview } = previewAt(liveData);
  const noApprove = runCli([
    '--fixture', FIXTURE, '--map', MAP, '--data', dest, '--apply',
  ]);
  ok(noApprove.code !== 0, 'apply without --approve fails');
  ok(/No approval/.test(noApprove.stderr), 'the error names the missing approval');
  ok(hashFile(dest) === before, 'missing approval does not touch the temp data.json');
  const wrong = runCli([
    '--fixture', FIXTURE, '--map', MAP, '--data', dest,
    '--apply', '--approve', '0'.repeat(64),
  ]);
  ok(wrong.code !== 0, 'apply with a non-matching previewId fails');
  ok(/does not match/.test(wrong.stderr), 'mismatch is named');
  ok(hashFile(dest) === before, 'mismatched approval does not touch the temp data.json');
  ok(hashFile(LIVE_DATA) === liveHash, 'live data.json remains untouched');
}

console.log('\n=== E. approved bounded write changes only the expected field ===');
{
  const dir = tempDir();
  const dest = writeTempData(dir, liveData);
  const { preview } = previewAt(liveData);
  const applied = runCli([
    '--fixture', FIXTURE, '--map', MAP, '--data', dest,
    '--apply', '--approve', preview.previewId,
  ]);
  ok(applied.code === 0, 'approved apply exits 0', applied.stderr.trim());
  const after = JSON.parse(fs.readFileSync(dest, 'utf8'));
  const beforeCash = liveData.plan.startingCash.breakdown.find(r => r.id === 'chequing-b').value;
  const afterCash = after.plan.startingCash.breakdown.find(r => r.id === 'chequing-b').value;
  ok(near(beforeCash, 932.05), 'fixture start is the live Chequing B $932.05');
  ok(near(afterCash, 922.05), 'approved write sets Chequing B to $922.05');
  ok(near(after.plan.startingCash.breakdown.find(r => r.id === 'chequing-a').value, 1320.13),
    'Chequing A is unchanged');
  ok(near(after.plan.startingCash.breakdown.find(r => r.id === 'savings').value, 0.58),
    'stale savings is not applied');
  ok(near(after.debts.find(d => d.id === 'triangle').balance, 13197),
    'Triangle same-day winner is not chosen');
  ok(after.meta.asOf === liveData.meta.asOf, 'opening as-of is not rewritten as a new cutover');
  ok((after.plan.opening.representedEvents || []).length === 0,
    'historical payroll did not backfill representedEvents onto the pinned opening');
  ok(JSON.stringify(after.plan.nextDollar) === JSON.stringify(liveData.plan.nextDollar),
    'policy fields are untouched');
  ok(hashFile(LIVE_DATA) === liveHash, 'live data.json was not the apply target');
}

console.log('\n=== F. second observe of the applied evidence proposes no duplicate ===');
{
  const dir = tempDir();
  const dest = writeTempData(dir, liveData);
  const { preview } = previewAt(liveData);
  const applied = runCli([
    '--fixture', FIXTURE, '--map', MAP, '--data', dest,
    '--apply', '--approve', preview.previewId,
  ]);
  ok(applied.code === 0, 'first approved apply succeeds');
  const updated = JSON.parse(fs.readFileSync(dest, 'utf8'));
  const again = previewAt(updated);
  ok(again.preview.proposed.length === 0,
    're-observe of the same evidence proposes no second write',
    `${again.preview.proposed.length} proposed`);
  const emptyApply = runCli([
    '--fixture', FIXTURE, '--map', MAP, '--data', dest,
    '--apply', '--approve', again.preview.previewId,
  ]);
  ok(emptyApply.code !== 0, 'empty preview cannot authorize another write');
  ok(near(updated.plan.startingCash.breakdown.find(r => r.id === 'chequing-b').value, 922.05),
    'the first write remains the only Chequing B change');
}

console.log('\n=== G. a correction stays on the same canonical field ===');
{
  const dir = tempDir();
  const dest = writeTempData(dir, liveData);
  const { preview } = previewAt(liveData);
  runCli([
    '--fixture', FIXTURE, '--map', MAP, '--data', dest,
    '--apply', '--approve', preview.previewId,
  ]);
  const updated = JSON.parse(fs.readFileSync(dest, 'utf8'));
  const correctedPayload = clone(payload);
  correctedPayload.accounts = correctedPayload.accounts.map(a => (
    a.id === 3002 ? Object.assign({}, a, { balance: 912.05 }) : a
  ));
  const next = previewAt(updated, correctedPayload);
  ok(next.preview.proposed.length === 1, 'the later correction is one proposed field');
  ok(next.preview.proposed[0].locator === 'cash:chequing-b',
    'the correction stays on cash:chequing-b');
  ok(near(next.preview.proposed[0].currentValue, 922.05), 'current value is the first write');
  ok(near(next.preview.proposed[0].proposedValue, 912.05), 'proposed value is the later correction');
}

console.log('\n=== H. write failure restores the original document ===');
{
  const dir = tempDir();
  const dest = writeTempData(dir, liveData);
  const before = fs.readFileSync(dest);
  const broken = {
    schema: C.SCHEMA,
    previewId: 'invalid',
    proposed: [{
      locator: 'cash:not-a-real-account',
      collection: 'cash',
      id: 'not-a-real-account',
      field: 'value',
      currentValue: 0,
      proposedValue: 1,
      evidenceDate: '2026-08-17',
      source: 'provider-observe:lunchmoney',
      reason: 'should fail',
    }],
  };
  let threw = false;
  try {
    C.applyPreview(JSON.parse(before.toString('utf8')), broken, dest);
  } catch (err) {
    threw = true;
    ok(/Refusing write|Missing cash row|Unsupported/.test(err.message),
      'invalid locator is refused before a successful replace',
      err.message);
  }
  ok(threw, 'invalid apply throws');
  ok(Buffer.compare(fs.readFileSync(dest), before) === 0,
    'failed apply leaves the temp data.json byte-identical');
  let parseThrew = false;
  try {
    C.replaceFileAtomically(dest, '{not-json');
  } catch (err) {
    parseThrew = true;
    ok(/JSON|Unexpected/.test(String(err.message)),
      'invalid encoded replacement is rejected',
      err.message);
  }
  ok(parseThrew, 'malformed replacement throws');
  ok(Buffer.compare(fs.readFileSync(dest), before) === 0,
    'rejected replacement leaves dest byte-identical');
  ok((() => { try { JSON.parse(fs.readFileSync(dest, 'utf8')); return true; } catch { return false; } })(),
    'data.json is not left malformed');
}

console.log('\n=== I. Forecast consumes the canonical write, not a parallel feed ===');
{
  const dir = tempDir();
  const dest = writeTempData(dir, liveData);
  const { preview, report } = previewAt(liveData);
  runCli([
    '--fixture', FIXTURE, '--map', MAP, '--data', dest,
    '--apply', '--approve', preview.previewId,
  ]);
  const after = JSON.parse(fs.readFileSync(dest, 'utf8'));
  const beforeCash = Forecast.startingCashAmount(liveData.plan);
  const afterCash = Forecast.startingCashAmount(after.plan);
  const independentBefore = independentSpendableOpening(liveData.plan);
  const independentAfter = independentSpendableOpening(after.plan);
  ok(near(beforeCash, independentBefore), 'pre-write Forecast cash matches household chequing');
  ok(near(afterCash, independentAfter), 'post-write Forecast cash matches the new household chequing');
  ok(near(afterCash - beforeCash, -10),
    'Forecast moved −$10, the Chequing B correction, not a second feed');
  ok(!Object.prototype.hasOwnProperty.call(after.plan.startingCash, 'amount'),
    'no parallel startingCash.amount was written');
  const rec = Forecast.recommend(after.plan, after.meta.asOf, { debts: after.debts });
  ok(rec && rec.weekly != null, 'Forecast.recommend still runs on the written document');
  ok(report.spendableCash !== afterCash || near(report.spendableCash, independentAfter),
    'the observation spendable figure is not a second canonical home');
  ok(preview.snapshotFollows === 'node scripts/snapshot-balances.js',
    'history stays the existing snapshot command');
  ok(!fs.existsSync(path.join(dir, 'snapshots')),
    'the refresh does not invent a snapshot directory');
}

console.log('\n=== J. live preview CLI does not write, and secrets stay out ===');
{
  const cli = runCli(['--fixture', FIXTURE, '--map', MAP, '--data', LIVE_DATA]);
  ok(cli.code === 0, 'preview CLI exits 0');
  const printed = JSON.parse(cli.stdout);
  ok(printed.writesCanonicalState === false, 'CLI preview is non-writing');
  ok(C.identityProofLooksSanitized(printed), 'CLI preview is sanitized');
  ok(hashFile(LIVE_DATA) === liveHash, 'preview CLI left live data.json untouched');
  const hook = fs.readFileSync(path.join(ROOT, '.githooks', 'pre-commit'), 'utf8');
  ok(/privacy-guard\.js/.test(hook), 'pre-commit delegates to the privacy-guard engine');
  const privacyGuard = fs.readFileSync(path.join(ROOT, 'scripts', 'privacy-guard.js'), 'utf8');
  ok(/LUNCHMONEY_ACCESS_TOKEN/.test(privacyGuard), 'privacy guard names LUNCHMONEY_ACCESS_TOKEN');
  const staticSrc = fs.readFileSync(path.join(ROOT, 'test', 'test-static.js'), 'utf8');
  ok(/LUNCHMONEY_ACCESS_TOKEN/.test(staticSrc), 'static scan names LUNCHMONEY_ACCESS_TOKEN');
  const render = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
  ok(/LUNCHMONEY_ACCESS_TOKEN/.test(render), 'Render declares the Lunch Money token name');
  ok(/key:\s*LUNCHMONEY_ACCESS_TOKEN[\s\S]*?sync:\s*false/.test(render),
    'Render Lunch Money token is owner-supplied');
  ok(!/key:\s*LUNCHMONEY_ACCESS_TOKEN[\s\S]*?value:/.test(render),
    'Render still has no Lunch Money token value');
  const observe = fs.readFileSync(path.join(ROOT, 'scripts', 'provider-observe.js'), 'utf8');
  ok(/method:\s*'GET'/.test(observe), 'observer remains GET-only');
  ok(!/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(fs.readFileSync(SCRIPT, 'utf8')),
    'refresh script issues no Lunch Money write method');
}

console.log('\n=== K. --preview-out cannot modify canonical state ===');
{
  const dir = tempDir();
  const dest = writeTempData(dir, liveData);
  const beforeDest = hashFile(dest);
  const sidecar = path.join(dir, 'preview.json');
  const attackDest = runCli([
    '--fixture', FIXTURE, '--map', MAP, '--data', dest,
    '--preview-out', dest,
  ]);
  ok(attackDest.code !== 0, '--preview-out targeting dest is refused');
  ok(/preview-out/.test(attackDest.stderr), 'the error names --preview-out');
  ok(hashFile(dest) === beforeDest, '--preview-out targeting dest leaves dest byte-identical');
  const attackSidecar = runCli([
    '--fixture', FIXTURE, '--map', MAP, '--data', dest,
    '--preview-out', sidecar,
  ]);
  ok(attackSidecar.code !== 0, '--preview-out to a sidecar is refused');
  ok(!fs.existsSync(sidecar), 'refused --preview-out does not create an output file');
  ok(hashFile(dest) === beforeDest, 'sidecar attempt leaves dest unchanged');
  const attackLive = runCli([
    '--fixture', FIXTURE, '--map', MAP, '--data', dest,
    '--preview-out', LIVE_DATA,
  ]);
  ok(attackLive.code !== 0, '--preview-out targeting live data.json is refused');
  ok(hashFile(LIVE_DATA) === liveHash, 'live data.json is unchanged by --preview-out');
  ok(hashFile(dest) === beforeDest, 'temp dest is unchanged by --preview-out live targeting');
  const attackCwd = runCli([
    '--fixture', FIXTURE, '--map', MAP, '--data', dest,
    '--preview-out', 'data.json',
  ]);
  ok(attackCwd.code !== 0, '--preview-out data.json from repo cwd is refused');
  ok(hashFile(LIVE_DATA) === liveHash, 'relative data.json preview-out did not overwrite live canonical state');
  const unknownOut = runCli([
    '--fixture', FIXTURE, '--map', MAP, '--data', dest,
    '--output', dest,
  ]);
  ok(unknownOut.code !== 0, 'an unknown output-path flag is refused');
  ok(hashFile(dest) === beforeDest && hashFile(LIVE_DATA) === liveHash,
    'unknown output-path flags cannot modify canonical state');
}

console.log('\n=== L. canonical replacement is a same-filesystem rename ===');
{
  const dir = tempDir();
  const dest = writeTempData(dir, liveData);
  const destResolved = path.resolve(dest);
  const nextDoc = clone(liveData);
  nextDoc.plan.startingCash.breakdown.find(r => r.id === 'chequing-b').value = 922.05;
  const nextBytes = `${JSON.stringify(nextDoc, null, 4)}\n`;
  const writeTargets = [];
  const renameOps = [];
  const origWrite = fs.writeFileSync;
  const origRename = fs.renameSync;
  fs.writeFileSync = function patchedWrite(p, data, opts) {
    writeTargets.push(path.resolve(String(p)));
    return origWrite.call(fs, p, data, opts);
  };
  fs.renameSync = function patchedRename(from, to) {
    renameOps.push({ from: path.resolve(String(from)), to: path.resolve(String(to)) });
    return origRename.call(fs, from, to);
  };
  try {
    C.replaceFileAtomically(dest, nextBytes);
  } finally {
    fs.writeFileSync = origWrite;
    fs.renameSync = origRename;
  }
  ok(!writeTargets.some(p => p === destResolved),
    'replacement does not writeFileSync onto dest');
  ok(renameOps.some(op => op.to === destResolved),
    'replacement renames a temp file onto dest');
  ok(renameOps.some(op => op.to === destResolved && path.dirname(op.from) === path.dirname(destResolved)),
    'the renamed temp file is in the same directory as dest');
  ok(!fs.existsSync(`${destResolved}.atlas-refresh-tmp`), 'temp file is not left behind');
  ok(!fs.existsSync(`${destResolved}.atlas-refresh-bak`), 'backup file is not left behind');
  const after = JSON.parse(fs.readFileSync(dest, 'utf8'));
  ok(near(after.plan.startingCash.breakdown.find(r => r.id === 'chequing-b').value, 922.05),
    'dest contains the replacement document');
}

console.log('\n=== M. replace refusal leaves dest present and byte-identical ===');
{
  const dir = tempDir();
  const dest = writeTempData(dir, liveData);
  const destResolved = path.resolve(dest);
  const before = hashFile(dest);
  const originalBytes = fs.readFileSync(dest);
  const nextDoc = clone(liveData);
  nextDoc.plan.startingCash.breakdown.find(r => r.id === 'chequing-b').value = 922.05;
  const nextBytes = `${JSON.stringify(nextDoc, null, 4)}\n`;
  const origRename = fs.renameSync;
  const renameOps = [];
  fs.renameSync = function patchedRename(from, to) {
    const fromResolved = path.resolve(String(from));
    const toResolved = path.resolve(String(to));
    renameOps.push({ from: fromResolved, to: toResolved });
    if (toResolved === destResolved) {
      const err = new Error('simulated Windows replace refusal');
      err.code = 'EPERM';
      throw err;
    }
    return origRename.call(fs, from, to);
  };
  let threw = false;
  let thrown = null;
  try {
    C.replaceFileAtomically(dest, nextBytes);
  } catch (err) {
    threw = true;
    thrown = err;
  } finally {
    fs.renameSync = origRename;
  }
  ok(threw, 'replace refusal is a failed refresh');
  ok(thrown && thrown.code === 'EPERM', 'the failure is the replace refusal, not a later restore');
  ok(fs.existsSync(dest), 'original destination is still present');
  ok(hashFile(dest) === before, 'original destination is byte-identical');
  ok(Buffer.compare(fs.readFileSync(dest), originalBytes) === 0,
    'original destination bytes are unchanged');
  ok(!renameOps.some(op => op.from === destResolved),
    'failure path never moves dest aside');
  ok(!fs.existsSync(`${destResolved}.atlas-refresh-bak`),
    'failure path does not create a dest-aside bak file');
  ok(!fs.existsSync(`${destResolved}.atlas-refresh-tmp`),
    'failed refresh cleans up the temp file');

  const src = fs.readFileSync(SCRIPT, 'utf8');
  ok(!/atlas-refresh-bak/.test(src), 'there is no dest-aside backup fallback');
  const { preview } = previewAt(liveData);
  fs.renameSync = function patchedRename(from, to) {
    if (path.resolve(String(to)) === destResolved) {
      const err = new Error('simulated replace failure');
      err.code = 'EPERM';
      throw err;
    }
    return origRename.call(fs, from, to);
  };
  let applyThrew = false;
  try {
    C.applyPreview(JSON.parse(originalBytes.toString('utf8')), preview, dest);
  } catch (err) {
    applyThrew = /simulated replace failure/.test(String(err && err.message || err));
  } finally {
    fs.renameSync = origRename;
  }
  ok(applyThrew, 'the refresh apply fails rather than falling back to a dest-aside swap');
  ok(fs.existsSync(dest), 'data.json still exists after apply failure');
  ok(Buffer.compare(fs.readFileSync(dest), originalBytes) === 0,
    'data.json remains byte-identical after apply failure');
  const still = JSON.parse(fs.readFileSync(dest, 'utf8'));
  ok(near(still.plan.startingCash.breakdown.find(r => r.id === 'chequing-b').value, 932.05),
    'no partial Chequing B replacement occurred');
}

console.log('\n=== A12. owner edit during the provider fetch is never overwritten (posted) ===');
{
  const { runWithConcurrentOwnerEdit } = require('./refresh-concurrent-edit-preload.js');
  const dir = tempDir();
  const dest = writeTempData(dir, liveData);
  const { preview } = previewAt(liveData);
  const res = runWithConcurrentOwnerEdit([
    '--fixture', FIXTURE, '--map', MAP, '--data', dest,
    '--apply', '--approve', preview.previewId,
  ], FIXTURE, dest);
  ok(res.code !== 0, 'posted: apply refuses when data.json changed during the fetch', res.stderr.trim());
  ok(res.refusedAsChanged, 'posted: refusal names the changed canonical file (compare-and-swap)');
  ok(res.ownerEditSurvived, 'posted: the invented owner instruction and $200 bill survive on disk');
  ok(res.after.plan.startingCash.breakdown.find(r => r.id === 'chequing-b').value
      === liveData.plan.startingCash.breakdown.find(r => r.id === 'chequing-b').value,
    'posted: the approved posted change was not merged into the edited file');
  ok(hashFile(LIVE_DATA) === liveHash, 'posted: live data.json untouched');

  // Library callers without baseline bytes are held to the loaded document.
  const libDir = tempDir();
  const libDest = writeTempData(libDir, liveData);
  const edited = clone(liveData);
  edited.meta.ownerInstruction = 'INVENTED concurrent owner instruction';
  fs.writeFileSync(libDest, `${JSON.stringify(edited, null, 4)}\n`);
  const editedBytes = fs.readFileSync(libDest);
  let libRefused = false;
  try {
    C.applyPreview(clone(liveData), preview, libDest);
  } catch (err) {
    libRefused = /changed since it was loaded/.test(String(err && err.message || err));
  }
  ok(libRefused, 'library applyPreview refuses a file that no longer holds the loaded document');
  ok(Buffer.compare(fs.readFileSync(libDest), editedBytes) === 0,
    'library refusal leaves the owner-edited bytes identical');
}

console.log('\n' + (failures ? `${failures} failure(s)` : 'All B81 refresh checks passed'));
if (hashFile(LIVE_DATA) !== liveHash) {
  console.log('LIVE data.json changed — failing closed');
  process.exit(1);
}
process.exit(failures ? 1 : 0);
