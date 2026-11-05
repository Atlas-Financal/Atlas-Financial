'use strict';
/* AF-REFRESH-04 — bounded canonical refresh preview from trusted reconciliation.
 *
 * Independent of classifyRefreshPreview / proposeFromReport: posted candidates
 * are rebuilt from mapped account balances + household dates + canonical
 * cash/debt values. Obligation buckets are rebuilt from the trusted
 * AF-REFRESH-03 receipt's settlement states, not by calling the preview
 * function twice. Canonical no-write of live files is a file-tree hash.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const O = require('../scripts/provider-observe.js');
const C = require('../scripts/canonical-refresh.js');
const Forecast = require('../public/forecast.js');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'lunchmoney-sample.json');
const SAMPLE_MAP = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'provider-account-map.json');
const PENDING = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'lunchmoney-pending-acceptance.json');
const PENDING_MAP = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'pending-account-map.json');
const AUTO = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'automatic-payment-settlement.json');
const IDENTITY = path.join(ROOT, 'docs', 'connectivity', 'transaction-identity.json');
const DATA = path.join(ROOT, 'data.json');
const POSITIONS = path.join(ROOT, 'docs', 'positions.csv');
const PERIODS = path.join(ROOT, 'public', 'periods.json');
const SNAPSHOTS = path.join(ROOT, 'snapshots');
const SCRIPT = path.join(ROOT, 'scripts', 'canonical-refresh.js');
const CMAW_ID = 'uniondues-aug15-outstanding';
const BCAA_ID = 'bcaa-aug15-outstanding';
const POSTED_CASH = new Set(['chequing-a', 'chequing-b', 'savings']);
const SYNTHETIC_CURRENT = 400;
const SYNTHETIC_OBSERVED = 390;

let failures = 0;
function ok(cond, label, detail) {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function near(a, b, eps) { return Math.abs(Number(a) - Number(b)) <= (eps == null ? 0.005 : eps); }
function hashFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
function hashTree() {
  const snapNames = fs.readdirSync(SNAPSHOTS).filter(n => n.endsWith('.json')).sort();
  const snap = snapNames.map(n => n + ':' + hashFile(path.join(SNAPSHOTS, n))).join('|');
  return {
    data: hashFile(DATA),
    positions: hashFile(POSITIONS),
    periods: hashFile(PERIODS),
    snapshots: crypto.createHash('sha256').update(snap).digest('hex'),
  };
}
function load(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function cashValue(data, id) {
  const row = (((data.plan || {}).startingCash || {}).breakdown || []).find(r => r && r.id === id);
  return row ? Number(row.value) : null;
}
function debtBalance(data, id) {
  const row = (data.debts || []).find(r => r && r.id === id);
  return row ? Number(row.balance) : null;
}
function setCash(data, id, value) {
  const row = data.plan.startingCash.breakdown.find(r => r.id === id);
  if (!row) throw new Error('missing cash ' + id);
  row.value = value;
}
function setDebt(data, id, value) {
  const row = data.debts.find(r => r.id === id);
  if (!row) throw new Error('missing debt ' + id);
  row.balance = value;
}

function withCompleteCoverage(payload, extraWindow) {
  const out = clone(payload);
  out.pendingCoverage = {
    complete: true,
    basis: O.PENDING_COVERAGE_BASIS,
    hasMore: false,
    startDate: null,
    endDate: null,
    truncated: false,
  };
  out.transactionWindow = Object.assign({
    startDate: '2026-08-16',
    endDate: '2026-08-20',
    complete: true,
    hasMore: false,
    truncated: false,
  }, extraWindow || {});
  return out;
}

function remapAutoTx(tx) {
  const accountId = tx.account_id === 1001 ? 3001
    : tx.account_id === 1002 ? 3002
      : tx.account_id;
  return Object.assign({}, tx, { account_id: accountId });
}

function readyTrustedPayload(opts) {
  opts = opts || {};
  const out = withCompleteCoverage(pendingPayload, opts.window);
  out.fetchedAt = opts.fetchedAt || '2026-08-20T16:00:00.000Z';
  let extra = (autoPayPayload.transactions || []).map(remapAutoTx);
  if (opts.omitCmaw) extra = extra.filter(tx => tx.id !== 8104);
  if (opts.omitUnmatched) extra = extra.filter(tx => tx.id !== 8199);
  if (opts.duplicateBcaa) {
    const bcaa = extra.find(tx => tx.id === 8101);
    extra.push(Object.assign({}, bcaa, { id: 8121 }));
  }
  out.transactions = (out.transactions || []).concat(extra);
  out.accounts = (out.accounts || []).map(account => Object.assign({}, account, {
    updated_at: opts.updatedAt || '2026-08-20T15:55:00.000Z', balance_last_update: opts.updatedAt || '2026-08-20T15:55:00.000Z',
  }));
  if (opts.chequingB != null) {
    out.accounts = out.accounts.map(account => (
      account.id === 3002 ? Object.assign({}, account, { balance: opts.chequingB }) : account
    ));
  }
  return out;
}

function alignMappedPosted(data, payload, accountMap) {
  for (const account of payload.accounts || []) {
    const mapping = O.mappingFor(accountMap, account.id);
    if (!mapping || !mapping.canonical || account.balance == null) continue;
    if (mapping.canonical.collection === 'cash' && POSTED_CASH.has(mapping.canonical.id)) {
      setCash(data, mapping.canonical.id, Number(account.balance));
    } else if (mapping.canonical.collection === 'debts') {
      setDebt(data, mapping.canonical.id, Number(account.balance));
    }
  }
}

function independentPosted(payload, accountMap, data) {
  const asOf = data.meta && data.meta.asOf;
  const rows = [];
  for (const account of payload.accounts || []) {
    const mapping = O.mappingFor(accountMap, account.id);
    if (!mapping || !mapping.canonical) continue;
    const id = mapping.canonical.id;
    const collection = mapping.canonical.collection;
    if (collection === 'cash' && !POSTED_CASH.has(id)) continue;
    if (collection !== 'cash' && collection !== 'debts') continue;
    const evidenceDate = Forecast.financialDate(account.updated_at || payload.fetchedAt);
    const current = collection === 'cash' ? cashValue(data, id) : debtBalance(data, id);
    const observed = Number(account.balance);
    if (!isFinite(current) || !isFinite(observed) || !evidenceDate || !asOf) continue;
    const rel = evidenceDate === asOf ? 'same-day'
      : (evidenceDate > asOf ? 'canonical-older'
        : (evidenceDate < asOf ? 'canonical-newer' : 'incomparable'));
    rows.push({
      locator: collection + ':' + id,
      collection,
      id,
      current,
      observed,
      evidenceDate,
      rel,
      match: near(current, observed),
    });
  }
  return rows;
}

function independentMechanicallyProvable(payload, accountMap, data) {
  return independentPosted(payload, accountMap, data)
    .filter(row => !row.match && row.rel === 'canonical-older')
    .sort((a, b) => String(a.locator).localeCompare(String(b.locator)));
}

function independentlyApply(data, proposed) {
  const next = clone(data);
  for (const change of proposed || []) {
    if (change.collection === 'cash' && change.field === 'value') {
      const row = next.plan.startingCash.breakdown.find(r => r.id === change.id);
      if (!row) throw new Error('missing cash ' + change.id);
      if (!near(row.value, change.currentValue)) {
        throw new Error('stale cash ' + change.locator);
      }
      row.value = Math.round(Number(change.proposedValue) * 100) / 100;
    } else if (change.collection === 'debts' && change.field === 'balance') {
      const row = next.debts.find(r => r.id === change.id);
      if (!row) throw new Error('missing debt ' + change.id);
      if (!near(row.balance, change.currentValue)) {
        throw new Error('stale debt ' + change.locator);
      }
      row.balance = Math.round(Number(change.proposedValue) * 100) / 100;
    } else {
      throw new Error('unsupported ' + change.locator);
    }
  }
  return next;
}

function numericState(data) {
  const out = {};
  for (const id of POSTED_CASH) out['cash:' + id] = cashValue(data, id);
  for (const row of data.debts || []) {
    if (row && row.id) out['debts:' + row.id] = Number(row.balance);
  }
  return out;
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-af-refresh-04-'));
}

function writeTempData(dir, data) {
  const dest = path.join(dir, 'data.json');
  fs.writeFileSync(dest, `${JSON.stringify(data, null, 4)}\n`);
  return dest;
}

function writeTempJson(dir, name, value) {
  const dest = path.join(dir, name);
  fs.writeFileSync(dest, `${JSON.stringify(value, null, 2)}\n`);
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

function previewAt(data, payload, accountMap) {
  return C.previewFrom({
    provider: 'lunchmoney',
    payload,
    accountMap,
    data,
    identity,
    fetchedAt: payload.fetchedAt,
  });
}

const samplePayload = load(SAMPLE);
const sampleMap = load(SAMPLE_MAP);
const pendingPayload = load(PENDING);
const pendingMap = load(PENDING_MAP);
const autoPayPayload = load(AUTO);
const identity = load(IDENTITY);
// Independent invented bill amounts, not values copied from the household.
// The three receipt amounts sum to 176.82 by hand.
function withInventedAutoBills(data) {
  const x = JSON.parse(JSON.stringify(data));
  const amounts = { bcaa: 41.37, icbc: 62.19, resp: 73.26,
    'bcaa-aug15-outstanding': 41.37, 'icbc-aug15-outstanding': 62.19,
    'resp-aug15-outstanding': 73.26 };
  for (const bill of x.plan.bills || []) if (Object.hasOwn(amounts, bill.id)) bill.amount = amounts[bill.id];
  return x;
}
const liveData = withInventedAutoBills(load(DATA));
const beforeTree = hashTree();

function trustedCase(extra) {
  extra = extra || {};
  const payload = readyTrustedPayload(Object.assign({
    chequingB: SYNTHETIC_OBSERVED,
    omitCmaw: extra.omitCmaw !== false,
    duplicateBcaa: extra.duplicateBcaa === true,
    omitUnmatched: extra.omitUnmatched === true,
  }, extra.payload || {}));
  const data = clone(liveData);
  alignMappedPosted(data, payload, pendingMap);
  setCash(data, 'chequing-b', SYNTHETIC_CURRENT);
  return { payload, data };
}

console.log('=== A. untrusted reconciliation cannot invent obligation writes ===');
{
  const { preview, report } = previewAt(liveData, samplePayload, sampleMap);
  ok(report.observationReceipt && report.observationReceipt.readyForReconciliation === false,
    'sample observation is not ready');
  ok(preview.reconciliationTrusted === false, 'preview reports untrusted reconciliation');
  ok(preview.failClosedKind === 'observation-not-ready',
    'untrusted preview names observation-not-ready',
    preview.failClosedKind);
  ok(!(preview.noops || []).some(row => row.settlement || row.id === CMAW_ID),
    'untrusted preview does not publish occurrence settlement as a write class');
  ok(!(preview.ownerQuestions || []).some(row => row.id === CMAW_ID),
    'untrusted preview does not invent a CMAW owner question');
  ok((preview.unsupported || []).some(row => row.reason === 'obligation-reconciliation-not-trusted'),
    'untrusted obligation classification is an unsupported fail-closed row');
  ok(!(preview.proposed || []).some(row => /uniondues|representedEvents|bills/.test(String(row.locator))),
    'untrusted packet does not propose an obligation or representedEvents write');
}

console.log('\n=== B. trusted preview distinguishes the five candidate classes ===');
{
  const { payload, data } = trustedCase();
  const { preview, report } = previewAt(data, payload, pendingMap);
  const indep = independentMechanicallyProvable(payload, pendingMap, data);
  const receipt = report.obligationReconciliationReceipt;
  ok(receipt && receipt.trusted === true, 'constructed packet has a trusted reconciliation receipt');
  ok(preview.reconciliationTrusted === true, 'preview consumes that trusted receipt');
  ok(preview.observationFingerprintDigest === receipt.observationFingerprintDigest,
    'preview binds the observation fingerprint from AF-REFRESH-03');
  ok(preview.writesCanonicalState === false && preview.canonicalWriteAuthorized === false,
    'preview is not an approval and does not write');
  ok(preview.unattended === false && preview.productionWrite === false,
    'preview is not unattended production');

  const proposedLocators = (preview.proposed || []).map(row => row.locator).sort();
  const indepLocators = indep.map(row => row.locator).sort();
  ok(JSON.stringify(proposedLocators) === JSON.stringify(indepLocators),
    'mechanically provable posted locators independently match the preview',
    proposedLocators.join(',') + ' vs ' + indepLocators.join(','));
  ok(preview.proposed.length === 1 && preview.proposed[0].locator === 'cash:chequing-b',
    'exactly one independently proven posted cash change is proposed');
  ok(near(preview.proposed[0].currentValue, SYNTHETIC_CURRENT)
    && near(preview.proposed[0].proposedValue, SYNTHETIC_OBSERVED),
    'proposed chequing-b is the synthetic 400 → 390 change');
  ok(JSON.stringify(preview.mechanicallyProvable) === JSON.stringify(preview.proposed),
    'mechanicallyProvable is exactly the proposed write set');

  ok((preview.noops || []).some(row => row.locator === 'cash:chequing-a' && row.reason === 'replay-match'),
    'matching posted chequing-a is classified as a replay no-op');
  ok((preview.noops || []).some(row => row.id === BCAA_ID && row.reason === 'obligation-represented-replay'),
    'represented BCAA is replayed evidence, not a posted write');
  ok(!(preview.ownerQuestions || []).some(row => row.id === CMAW_ID),
    'cancelled CMAW dues are not an owner-fact question');
  ok((preview.unresolved || []).some(row => row.reason === 'unmatched-household-cash-must-not-write'),
    'unmatched household cash is unresolved and must not write');
  ok((preview.unsupported || []).some(row => row.reason === 'unmapped-provider-account'
    || row.reason === 'historical-opening-backfill'
    || row.reason === 'credit-capacity-not-cash'),
    'incumbent refused targets remain unsupported');
  ok(!(preview.proposed || []).some(row => row.locator === 'plan.opening.representedEvents'),
    'represented evidence does not leak into the posted write set');
  const cashArtifact = (preview.downstreamArtifacts || []).find(row => row.kind === 'forecast-starting-cash');
  ok(cashArtifact && cashArtifact.wouldChange === true && near(cashArtifact.independentDelta, -10),
    'preview names that Forecast starting cash would move by the independently summed −$10');
  ok((preview.downstreamArtifacts || []).some(row => row.kind === 'snapshot-balances' && row.wouldChange === false),
    'posted preview does not claim a snapshot write');
  ok(!Object.prototype.hasOwnProperty.call(preview, 'recommend')
    && !Object.prototype.hasOwnProperty.call(preview, 'paydayAllocation')
    && !Object.prototype.hasOwnProperty.call(preview, 'spendPermission'),
    'preview does not publish the operating answer');
}

console.log('\n=== C. preview is deterministic and sanitized ===');
{
  const { payload, data } = trustedCase();
  const first = previewAt(data, payload, pendingMap).preview;
  const second = previewAt(clone(data), clone(payload), pendingMap).preview;
  ok(first.previewId === second.previewId, 'second preview of identical evidence shares previewId');
  ok(JSON.stringify(first.proposed) === JSON.stringify(second.proposed),
    'proposed set is byte-stable');
  ok(JSON.stringify(first.noops) === JSON.stringify(second.noops)
    && JSON.stringify(first.unresolved) === JSON.stringify(second.unresolved)
    && JSON.stringify(first.ownerQuestions) === JSON.stringify(second.ownerQuestions),
    'classification buckets are byte-stable');
  ok(C.identityProofLooksSanitized(first), 'preview omits provider IDs, transaction IDs, and the token name');
  const blob = JSON.stringify(first);
  ok(!/"payee"\s*:/.test(blob) && !/CMAWLOCAL1995|SEASPAN|Bcaa-adv|8101|3001/.test(blob),
    'preview has no raw payees or fixture provider ids');
}

console.log('\n=== D. stale and missing approvals fail closed ===');
{
  const { payload, data } = trustedCase();
  const dir = tempDir();
  const dest = writeTempData(dir, data);
  const fixture = writeTempJson(dir, 'payload.json', payload);
  const before = hashFile(dest);
  const { preview } = previewAt(data, payload, pendingMap);
  const noApprove = runCli([
    '--fixture', fixture, '--map', PENDING_MAP, '--data', dest, '--apply',
  ]);
  ok(noApprove.code !== 0, 'apply without --approve fails');
  ok(/No approval/.test(noApprove.stderr), 'the error names the missing approval');
  ok(hashFile(dest) === before, 'missing approval does not touch the temp data.json');
  const wrong = runCli([
    '--fixture', fixture, '--map', PENDING_MAP, '--data', dest,
    '--apply', '--approve', '0'.repeat(64),
  ]);
  ok(wrong.code !== 0, 'apply with a non-matching previewId fails');
  ok(/does not match/.test(wrong.stderr), 'mismatch is named');
  ok(hashFile(dest) === before, 'mismatched approval does not touch the temp data.json');

  const mutated = clone(data);
  setCash(mutated, 'chequing-b', SYNTHETIC_CURRENT + 5);
  fs.writeFileSync(dest, `${JSON.stringify(mutated, null, 4)}\n`);
  const staleCli = runCli([
    '--fixture', fixture, '--map', PENDING_MAP, '--data', dest,
    '--apply', '--approve', preview.previewId,
  ]);
  ok(staleCli.code !== 0, 'approval of a now-stale dest fails');
  ok(near(cashValue(JSON.parse(fs.readFileSync(dest, 'utf8')), 'chequing-b'), SYNTHETIC_CURRENT + 5),
    'stale approval left the mutated dest unwritten by the old preview');

  fs.writeFileSync(dest, `${JSON.stringify(data, null, 4)}\n`);
  let staleLib = false;
  try {
    C.applyPreview(mutated, preview, dest);
  } catch (err) {
    staleLib = /Stale preview/.test(String(err && err.message || err));
  }
  ok(staleLib, 'library apply of a stale currentValue fails closed');
}

console.log('\n=== E. exact approval writes only independently previewed targets ===');
{
  const { payload, data } = trustedCase();
  const dir = tempDir();
  const dest = writeTempData(dir, data);
  const fixture = writeTempJson(dir, 'payload.json', payload);
  const { preview } = previewAt(data, payload, pendingMap);
  const beforeNums = numericState(data);
  const expected = independentlyApply(data, preview.proposed);
  const expectedNums = numericState(expected);
  const applied = runCli([
    '--fixture', fixture, '--map', PENDING_MAP, '--data', dest,
    '--apply', '--approve', preview.previewId,
  ]);
  ok(applied.code === 0, 'approved apply exits 0', applied.stderr.trim());
  const after = JSON.parse(fs.readFileSync(dest, 'utf8'));
  const afterNums = numericState(after);
  ok(near(cashValue(after, 'chequing-b'), SYNTHETIC_OBSERVED),
    'approved write sets chequing-b to the independently previewed 390');
  ok(near(cashValue(after, 'chequing-a'), cashValue(data, 'chequing-a')),
    'chequing-a is unchanged');
  ok(near(cashValue(after, 'savings'), cashValue(data, 'savings')),
    'savings is unchanged');
  for (const locator of Object.keys(beforeNums)) {
    if (locator === 'cash:chequing-b') continue;
    ok(near(beforeNums[locator], afterNums[locator]),
      `${locator} is unchanged by the bounded write`);
  }
  ok(near(afterNums['cash:chequing-b'], expectedNums['cash:chequing-b']),
    'written chequing-b independently matches the previewed document');
  ok(JSON.stringify(after.plan.nextDollar) === JSON.stringify(data.plan.nextDollar),
    'policy fields are untouched');
  ok((after.plan.opening.representedEvents || []).length
    === (data.plan.opening.representedEvents || []).length,
    'representedEvents were not written by posted previewId');
  const cmawBefore = JSON.stringify((data.plan.bills || []).find(b => b.id === CMAW_ID) || null);
  const cmawAfter = JSON.stringify((after.plan.bills || []).find(b => b.id === CMAW_ID) || null);
  ok(cmawBefore === cmawAfter && cmawBefore === 'null',
    'cancelled CMAW bill remains absent');
  ok(after.meta.asOf === data.meta.asOf, 'opening as-of is not rewritten');
}

console.log('\n=== F. unresolved and owner-fact rows cannot write ===');
{
  const { payload, data } = trustedCase({ duplicateBcaa: true });
  const { preview } = previewAt(data, payload, pendingMap);
  ok((preview.unresolved || []).some(row => row.id === BCAA_ID
    && row.reason === 'ambiguous-evidence-must-not-write'),
    'duplicate BCAA is unresolved/ambiguous');
  ok(!(preview.proposed || []).some(row => row.id === BCAA_ID || /bcaa/.test(String(row.locator))),
    'ambiguous BCAA is not in the proposed write set');
  ok(!(preview.proposed || []).some(row => row.id === CMAW_ID),
    'owner-fact CMAW is not in the proposed write set');
  ok(!(preview.proposed || []).some(row => row.evidenceFingerprint
    && (preview.unresolved || []).some(u => u.evidenceFingerprint === row.evidenceFingerprint)),
    'unmatched evidence fingerprints are not proposed writes');

  const forged = clone(preview);
  forged.proposed = preview.proposed.concat([{
    locator: 'cash:savings',
    collection: 'cash',
    id: 'savings',
    field: 'value',
    currentValue: cashValue(data, 'savings'),
    proposedValue: cashValue(data, 'savings') + 1,
    evidenceDate: '2026-08-20',
    source: 'provider-observe:lunchmoney',
    reason: 'forged unresolved write',
  }]);
  forged.mechanicallyProvable = forged.proposed;
  if (!(forged.unsupported || []).some(row => row.locator === 'cash:savings')) {
    forged.unsupported = (forged.unsupported || []).concat([{
      locator: 'cash:savings',
      reason: 'stale-not-current',
    }]);
  }
  const dir = tempDir();
  const dest = writeTempData(dir, data);
  const before = hashFile(dest);
  let refusedForge = false;
  try {
    C.applyPreview(data, forged, dest);
  } catch (err) {
    refusedForge = /cannot write|Unsupported|Stale|mechanically/.test(String(err && err.message || err));
  }
  ok(refusedForge, 'a forged write of an unsupported/unresolved locator is refused');
  ok(hashFile(dest) === before, 'forged unresolved write left dest byte-identical');

  const billForge = clone(preview);
  billForge.proposed = [{
    locator: 'plan.bills:' + CMAW_ID,
    collection: 'plan',
    id: CMAW_ID,
    field: 'amount',
    currentValue: 25,
    proposedValue: 0,
    evidenceDate: '2026-08-15',
    source: 'provider-observe:lunchmoney',
    reason: 'forged owner-fact write',
  }];
  billForge.mechanicallyProvable = billForge.proposed;
  let refusedBill = false;
  try {
    C.applyPreview(data, billForge, dest);
  } catch (err) {
    refusedBill = /Refusing write|Unsupported|cannot write|representedEvents/.test(
      String(err && err.message || err)
    );
  }
  ok(refusedBill, 'a forged CMAW bill write is refused');
  ok(hashFile(dest) === before, 'forged owner-fact write left dest byte-identical');
}

console.log('\n=== G. replay after approval is an independent no-op ===');
{
  const { payload, data } = trustedCase();
  const dir = tempDir();
  const dest = writeTempData(dir, data);
  const fixture = writeTempJson(dir, 'payload.json', payload);
  const { preview } = previewAt(data, payload, pendingMap);
  const applied = runCli([
    '--fixture', fixture, '--map', PENDING_MAP, '--data', dest,
    '--apply', '--approve', preview.previewId,
  ]);
  ok(applied.code === 0, 'first approved apply succeeds');
  const updated = JSON.parse(fs.readFileSync(dest, 'utf8'));
  const again = previewAt(updated, payload, pendingMap);
  const indepAgain = independentMechanicallyProvable(payload, pendingMap, updated);
  ok(again.preview.proposed.length === 0, 'replay proposes no second write',
    `${again.preview.proposed.length} proposed`);
  ok(indepAgain.length === 0, 'independent posted reconstruction also has no CHANGE');
  ok((again.preview.noops || []).some(row => row.locator === 'cash:chequing-b' && row.reason === 'replay-match'),
    'the previously written chequing-b is now a replay no-op');
  const emptyApply = runCli([
    '--fixture', fixture, '--map', PENDING_MAP, '--data', dest,
    '--apply', '--approve', again.preview.previewId,
  ]);
  ok(emptyApply.code !== 0, 'empty replay preview cannot authorize another write');
  ok(near(cashValue(updated, 'chequing-b'), SYNTHETIC_OBSERVED),
    'the first write remains the only chequing-b change');
}

console.log('\n=== H. CLI preview is non-writing and incumbents remain ===');
{
  const { payload, data } = trustedCase();
  const dir = tempDir();
  const dest = writeTempData(dir, data);
  const fixture = writeTempJson(dir, 'payload.json', payload);
  const beforeDest = hashFile(dest);
  const cli = runCli(['--fixture', fixture, '--map', PENDING_MAP, '--data', dest]);
  ok(cli.code === 0, 'preview CLI exits 0', cli.stderr.trim());
  const printed = JSON.parse(cli.stdout);
  ok(printed.writesCanonicalState === false, 'CLI preview is non-writing');
  ok(printed.reconciliationTrusted === true, 'CLI preview consumed the trusted receipt');
  ok(printed.proposed.length === 1 && printed.proposed[0].locator === 'cash:chequing-b',
    'CLI preview proposes the same independently proven locator');
  ok(C.identityProofLooksSanitized(printed), 'CLI preview is sanitized');
  ok(hashFile(dest) === beforeDest, 'preview CLI left the temp dest untouched');
  const observeSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'provider-observe.js'), 'utf8');
  const refreshSrc = fs.readFileSync(SCRIPT, 'utf8');
  ok(/function reconciliationReceipt/.test(observeSrc),
    'incumbent obligation-reconciliation receipt remains');
  ok(/previewId|approve/.test(refreshSrc), 'incumbent preview/approve writer remains');
  ok(!/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(refreshSrc),
    'refresh script issues no Lunch Money write method');
  ok(!/setInterval|node-cron|cron\.schedule/.test(refreshSrc),
    'refresh script does not add a scheduler');
}

console.log('\n=== I. posted approval identity ignores volatile fetchedAt ===');
{
  const firstCase = trustedCase({ payload: { fetchedAt: '2026-08-20T16:00:00.000Z' } });
  const laterCase = trustedCase({ payload: { fetchedAt: '2026-08-20T18:30:00.000Z' } });
  const first = previewAt(firstCase.data, firstCase.payload, pendingMap);
  const later = previewAt(laterCase.data, laterCase.payload, pendingMap);
  ok(first.report.observationReceipt.observedAt !== later.report.observationReceipt.observedAt,
    'the two observations have different fetch timestamps');
  ok(first.preview.observationFingerprintDigest !== later.preview.observationFingerprintDigest,
    'AF-REFRESH-02 observation digest still changes with fetchedAt');
  ok(first.preview.previewId === later.preview.previewId,
    'identical evidence at two same-day fetchedAt values shares the posted previewId');
  ok(JSON.stringify(first.preview.proposed) === JSON.stringify(later.preview.proposed),
    'the proposed write set is unchanged across those fetches');

  const dir = tempDir();
  const dest = writeTempData(dir, firstCase.data);
  const laterFixture = writeTempJson(dir, 'later.json', laterCase.payload);
  const applied = runCli([
    '--fixture', laterFixture, '--map', PENDING_MAP, '--data', dest,
    '--apply', '--approve', first.preview.previewId,
  ]);
  ok(applied.code === 0, 'the earlier previewId still approves a later same-day fetch of identical evidence',
    applied.stderr.trim());
  ok(near(cashValue(JSON.parse(fs.readFileSync(dest, 'utf8')), 'chequing-b'), SYNTHETIC_OBSERVED),
    'that later-fetched approval wrote the independently previewed chequing-b');

  const materialCase = trustedCase({
    payload: { fetchedAt: '2026-08-20T18:30:00.000Z', chequingB: SYNTHETIC_OBSERVED - 7 },
  });
  const material = previewAt(materialCase.data, materialCase.payload, pendingMap);
  ok(material.preview.previewId !== first.preview.previewId,
    'a material observed-balance change changes the posted previewId');
  ok(near(material.preview.proposed[0].proposedValue, SYNTHETIC_OBSERVED - 7),
    'the changed observation independently proposes 383, not 390');

  const staleDest = writeTempData(dir, firstCase.data);
  const materialFixture = writeTempJson(dir, 'material.json', materialCase.payload);
  const stale = runCli([
    '--fixture', materialFixture, '--map', PENDING_MAP, '--data', staleDest,
    '--apply', '--approve', first.preview.previewId,
  ]);
  ok(stale.code !== 0, 'the earlier previewId is refused when the observed evidence changed');
  ok(/does not match/.test(stale.stderr), 'the refusal names the previewId mismatch');
  ok(near(cashValue(JSON.parse(fs.readFileSync(staleDest, 'utf8')), 'chequing-b'), SYNTHETIC_CURRENT),
    'the stale approval left canonical chequing-b unwritten');

  const nextDay = trustedCase({ payload: { fetchedAt: '2026-08-21T16:00:00.000Z' } });
  const nextPreview = previewAt(nextDay.data, nextDay.payload, pendingMap);
  ok(nextPreview.preview.previewId !== first.preview.previewId,
    'a different household observation date changes posted previewId');
}

console.log('\n=== J. live canonical files are unchanged ===');
{
  const after = hashTree();
  ok(after.data === beforeTree.data, 'live data.json bytes unchanged');
  ok(after.positions === beforeTree.positions, 'positions.csv bytes unchanged');
  ok(after.periods === beforeTree.periods, 'periods.json bytes unchanged');
  ok(after.snapshots === beforeTree.snapshots, 'snapshots/ bytes unchanged');
}

console.log('\n' + (failures ? `${failures} failure(s)` : 'All AF-REFRESH-04 canonical-preview checks passed.'));
if (hashTree().data !== beforeTree.data) {
  console.log('LIVE data.json changed — failing closed');
  process.exit(1);
}
process.exit(failures ? 1 : 0);
