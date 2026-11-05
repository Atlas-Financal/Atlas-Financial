'use strict';
/* B81 opening state transition — one approved live opening must leave
 * one coherent repository state: data.json, same-date Household evidence,
 * derived positions rows, and snapshots/<date>.json.
 *
 * Proves the production defect: an approved opening used to advance
 * data.json and then tell the operator to run snapshot-balances.js, which
 * refuses because Household rows were never dated. The writer must now
 * construct that whole transition before any canonical file is committed.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const C = require('../scripts/canonical-refresh.js');
const S = require('../scripts/snapshot-balances.js');
const POS = require('../scripts/positions-summary.js');
const Household = require('../scripts/opening-household-rows.js');
const Forecast = require('../public/forecast.js');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'canonical-refresh.js');
const LIVE_DATA = path.join(ROOT, 'data.json');
const LIVE_POSITIONS = path.join(ROOT, 'docs', 'positions.csv');
const LIVE_SNAPSHOTS = path.join(ROOT, 'snapshots');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const clone = x => JSON.parse(JSON.stringify(x));
const cashOf = (data, id) => data.plan.startingCash.breakdown.find(r => r.id === id);
const debtOf = (data, id) => data.debts.find(d => d.id === id);

const liveHash = hashFile(LIVE_DATA);
const livePosHash = hashFile(LIVE_POSITIONS);
const liveSnap16Hash = hashFile(path.join(LIVE_SNAPSHOTS, '2026-08-16.json'));
const liveSnap19Path = path.join(LIVE_SNAPSHOTS, '2026-08-19.json');
const liveSnap19Hash = fs.existsSync(liveSnap19Path) ? hashFile(liveSnap19Path) : null;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-opening-state-'));
}

function writeJson(dir, name, value) {
  const dest = path.join(dir, name);
  fs.writeFileSync(dest, `${JSON.stringify(value, null, 2)}\n`);
  return dest;
}

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT].concat(args), {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: err.status == null ? 1 : err.status,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || ''),
    };
  }
}

function makeData(extra) {
  const asOf = (extra && extra.asOf) || '2026-08-16';
  const data = {
    meta: { asOf },
    plan: {
      windowDays: 28,
      defaults: { targetBuffer: 0 },
      startingCash: {
        breakdown: [
          { id: 'chequing-a', value: 1000 },
          { id: 'chequing-b', value: 200 },
          { id: 'savings', value: 50 },
        ],
      },
      opening: { asOf, representedEvents: [] },
      nextDollar: { target: 'cashback', provenance: 'derived' },
      income: [], obligations: [], bills: [], commitments: [],
    },
    debts: (extra && extra.debts) || [
      {
        id: 'mortgage',
        label: 'Mortgage',
        institution: 'TD',
        balance: 500000,
        pending: 0,
        secured: true,
        interestTreatment: 'paid-in-payment',
        limit: null,
      },
    ],
  };
  if (extra && extra.cash) {
    for (const row of data.plan.startingCash.breakdown) {
      if (extra.cash[row.id] != null) row.value = extra.cash[row.id];
    }
  }
  if (extra && extra.assets) data.assets = extra.assets;
  return data;
}

function makeProviderMap(entries) {
  return {
    schema: 'atlas-provider-account-map/v1',
    provider: 'lunchmoney',
    scope: 'fixture',
    mappings: [
      { providerAccountId: '4101', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
      { providerAccountId: '4102', canonical: { collection: 'cash', id: 'chequing-b' }, atlasRole: 'household-cash' },
      { providerAccountId: '4103', canonical: { collection: 'cash', id: 'savings' }, atlasRole: 'household-cash' },
      { providerAccountId: '4108', canonical: { collection: 'debts', id: 'mortgage' }, atlasRole: 'mortgage' },
    ].concat((entries || []).map(entry => ({
      providerAccountId: String(entry.providerAccountId),
      canonical: { collection: entry.collection, id: entry.id },
      atlasRole: entry.role,
    }))),
  };
}

function accountRow(spec) {
  const row = {
    id: spec.id,
    name: spec.name || String(spec.id),
    type: spec.type || 'cash',
    subtype: spec.subtype,
    balance: spec.balance,
    currency: 'cad',
    credit_limit: spec.limit,
    updated_at: spec.updatedAt || `${spec.evidenceDate}T17:55:00.000Z`,
    balance_last_update: spec.updatedAt || `${spec.evidenceDate}T17:55:00.000Z`,
  };
  if (spec.balanceAsOf) row.balance_as_of = spec.balanceAsOf;
  return row;
}

function matchingPostedAccounts(data, evidenceDate) {
  return [
    accountRow({
      id: 4101, name: 'Chequing A', type: 'cash', subtype: 'checking',
      balance: cashOf(data, 'chequing-a').value, evidenceDate,
    }),
    accountRow({
      id: 4102, name: 'Chequing B', type: 'cash', subtype: 'checking',
      balance: cashOf(data, 'chequing-b').value, evidenceDate,
    }),
    accountRow({
      id: 4103, name: 'Savings', type: 'cash', subtype: 'savings',
      balance: cashOf(data, 'savings').value, evidenceDate,
    }),
    accountRow({
      id: 4108, name: 'Mortgage', type: 'loan', subtype: 'mortgage',
      balance: debtOf(data, 'mortgage').balance, evidenceDate,
    }),
  ];
}

function makePayload(fetchedAsOf, accounts, transactions, extra) {
  return Object.assign({
    provider: 'lunchmoney',
    fetchedAt: `${fetchedAsOf}T18:00:00.000Z`,
    source: 'Synthetic opening-state fixture. Not a live institution pull. Fixture IDs 4101–4199 are not live provider IDs.',
    accounts,
    transactions: transactions || [],
  }, extra || {});
}

function completePendingCoverage() {
  return {
    pendingCoverage: {
      complete: true,
      basis: 'is_pending-unbounded',
      hasMore: false,
      startDate: null,
      endDate: null,
    },
  };
}

function csvLine(cols) {
  return cols.map(v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',');
}

function fixturePositions(data, extraRows, confidenceByLabel) {
  const header = 'entity,institution,account_label,account_type,side,currency,balance,credit_limit,available,interest_rate_pct,rate_basis,fixed_or_variable,structure,payment_amount,payment_frequency,next_due_date,maturity_or_renewal,annual_interest_cost,confidence,as_of,notes';
  const asOf = data.meta.asOf;
  const lines = [header];
  const labels = { 'chequing-a': 'Chequing A', 'chequing-b': 'Chequing B', savings: 'Savings' };
  for (const row of data.plan.startingCash.breakdown) {
    const cols = new Array(21).fill('');
    cols[0] = 'Household'; cols[1] = 'TD'; cols[2] = labels[row.id];
    cols[3] = row.id === 'savings' ? 'Savings' : 'Chequing';
    cols[4] = 'Asset'; cols[5] = 'CAD'; cols[6] = Number(row.value).toFixed(2);
    if (row.id === 'chequing-b') { cols[7] = '600.00'; cols[8] = '600.00'; }
    else cols[8] = Number(row.value).toFixed(2);
    cols[12] = 'Transactional';
    cols[18] = (confidenceByLabel && confidenceByLabel[labels[row.id]]) || 'VERIFIED_TD';
    cols[19] = asOf;
    cols[20] = 'incumbent captured Household row';
    lines.push(csvLine(cols));
  }
  for (const debt of data.debts) {
    const name = {
      mortgage: 'Mortgage', travelvisa: 'Travel Visa', cashback: 'Cash Back Visa',
      triangle: 'Triangle Mastercard', heloc: 'HELOC',
    }[debt.id] || debt.id;
    const cols = new Array(21).fill('');
    cols[0] = 'Household'; cols[1] = 'TD'; cols[2] = name;
    cols[3] = debt.id === 'mortgage' ? 'Mortgage' : 'Credit card';
    cols[4] = 'Liability'; cols[5] = 'CAD'; cols[6] = Number(debt.balance).toFixed(2);
    if (debt.limit != null) cols[7] = Number(debt.limit).toFixed(2);
    cols[12] = debt.secured ? 'Amortizing' : 'Revolving';
    cols[18] = (confidenceByLabel && confidenceByLabel[name]) || 'VERIFIED_TD';
    cols[19] = asOf;
    cols[20] = 'incumbent captured Household row';
    lines.push(csvLine(cols));
  }
  const wise = new Array(21).fill('');
  wise[0] = 'Household'; wise[1] = 'Wise'; wise[2] = 'Wise account 1 (USD spending)';
  wise[3] = 'Prepaid multi-currency'; wise[4] = 'Asset'; wise[5] = 'USD';
  wise[6] = '1.92'; wise[8] = '1.92'; wise[18] = 'CALCULATED'; wise[19] = '2026-08-09';
  wise[20] = 'excluded standing account';
  lines.push(csvLine(wise));
  for (const extra of extraRows || []) lines.push(extra);
  return `${lines.join('\n')}\n`;
}

function fixtureBalanceMap(data) {
  const mappings = [
    { observationId: 'pos-chequing-a', accountLabel: 'Chequing A', canonical: { collection: 'cash', id: 'chequing-a' } },
    { observationId: 'pos-chequing-b', accountLabel: 'Chequing B', canonical: { collection: 'cash', id: 'chequing-b' } },
    { observationId: 'pos-savings', accountLabel: 'Savings', canonical: { collection: 'cash', id: 'savings' } },
  ];
  for (const debt of data.debts) {
    const label = {
      mortgage: 'Mortgage', travelvisa: 'Travel Visa', cashback: 'Cash Back Visa',
      triangle: 'Triangle Mastercard', heloc: 'HELOC',
    }[debt.id] || debt.id;
    mappings.push({
      observationId: `pos-${debt.id}`,
      accountLabel: label,
      canonical: { collection: 'debts', id: debt.id },
    });
  }
  return {
    schema: 'atlas-balance-reconciliation-map/v1',
    excluded: [{
      accountLabel: 'Wise account 1 (USD spending)',
      reason: 'Two Wise rows share one canonical cash id; this slice maps one observation to one id.',
    }],
    mappings,
  };
}

function workspace(dir, data, extra) {
  const dataPath = writeJson(dir, 'data.json', data);
  const positionsPath = path.join(dir, 'positions.csv');
  const snapshotDir = path.join(dir, 'snapshots');
  const balanceMapPath = writeJson(dir, extra && extra.balanceMapName || 'balance-map.json', fixtureBalanceMap(data));
  fs.writeFileSync(
    positionsPath,
    fixturePositions(data, extra && extra.extraRows, extra && extra.confidenceByLabel)
  );
  fs.mkdirSync(snapshotDir, { recursive: true });
  return { dataPath, positionsPath, snapshotDir, balanceMapPath };
}

function resolveError(args) {
  try {
    C.resolveOpeningArtifactPaths(args);
    return '';
  } catch (err) {
    return String(err.message || err);
  }
}

function previewAt(data, payload, extra) {
  return C.previewFrom({
    provider: 'lunchmoney',
    payload,
    accountMap: extra.accountMap,
    data,
    identity: extra.identity || { rules: [], billPaymentPayees: [] },
    fetchedAt: payload.fetchedAt,
  }, extra.cutoverAsOf ? {
    cutoverAsOf: extra.cutoverAsOf,
    balanceMap: extra.balanceMap || fixtureBalanceMap(data),
  } : undefined);
}

function cleanPacket(extra) {
  const data = makeData(extra);
  const map = makeProviderMap(extra && extra.providerEntries);
  let accounts = matchingPostedAccounts(data, '2026-08-18');
  if (extra && extra.accounts) accounts = extra.accounts(data, accounts);
  const payload = makePayload('2026-08-18', accounts, extra && extra.transactions, Object.assign(
    completePendingCoverage(),
    extra && extra.payloadExtra || {}
  ));
  return { data, map, payload };
}

function applyArgs(ws, pkt, approval, extra) {
  return [
    '--fixture', writeJson(path.dirname(ws.dataPath), extra && extra.payloadName || 'payload.json', pkt.payload),
    '--map', writeJson(path.dirname(ws.dataPath), extra && extra.mapName || 'map.json', pkt.map),
    '--data', ws.dataPath,
    '--positions', ws.positionsPath,
    '--snapshots', ws.snapshotDir,
    '--balance-map', ws.balanceMapPath,
    '--cutover-as-of', (extra && extra.asOf) || '2026-08-18',
    '--apply', '--approve-opening', approval,
  ];
}

function householdRows(text) {
  return S.parsePositions(text).filter(row => row.entity === 'Household');
}

function household(text, label) {
  return householdRows(text).find(row => row.account_label === label) || null;
}

console.log('=== 0. reproduce the failed Aug. 19 class of defect against incumbents ===');
{
  const pkt = cleanPacket({ cash: { 'chequing-b': 190 } });
  pkt.payload.accounts = matchingPostedAccounts(pkt.data, '2026-08-18').map(row => (
    row.id === 4102 ? Object.assign({}, row, { balance: 190 }) : row
  ));
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  ok(preview.openingCutover.cutoverWriteSupported === true && preview.openingCutover.openingApprovalId,
    'a valid opening candidate can still be approved');
  const next = clone(pkt.data);
  for (const change of preview.openingCutover.proposedOpening.posted) {
    C.applyChange(next, {
      locator: change.locator, field: change.field,
      currentValue: change.currentValue, proposedValue: change.proposedValue,
    });
  }
  next.meta.asOf = '2026-08-18';
  next.plan.opening.asOf = '2026-08-18';
  const oldPositions = fixturePositions(pkt.data);
  ok(household(oldPositions, 'Chequing A').as_of === '2026-08-16',
    'incumbent Household evidence remains the previous opening date');
  let refused = null;
  try {
    S.buildSnapshot(next, S.parsePositions(oldPositions), fixtureBalanceMap(pkt.data));
  } catch (err) { refused = err.message; }
  ok(/no same-date accounts for 2026-08-18/.test(String(refused)),
    'snapshot writer still refuses empty same-date snapshots — that is the proven defect class',
    refused);
}

console.log('\n=== 1. successful approved opening produces one coherent state ===');
{
  const pkt = cleanPacket();
  pkt.payload.accounts = matchingPostedAccounts(pkt.data, '2026-08-18').map(row => (
    row.id === 4102 ? Object.assign({}, row, { balance: 190 }) : row
  ));
  const independentCash = 1000 + 190;
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  const dir = tempDir();
  const ws = workspace(dir, pkt.data);
  const beforeData = hashFile(ws.dataPath);
  const beforePos = hashFile(ws.positionsPath);
  const applied = runCli(applyArgs(ws, pkt, preview.openingCutover.openingApprovalId));
  ok(applied.code === 0, 'approved opening apply succeeds', applied.stderr.trim());
  const after = JSON.parse(fs.readFileSync(ws.dataPath, 'utf8'));
  const posText = fs.readFileSync(ws.positionsPath, 'utf8');
  const snapPath = path.join(ws.snapshotDir, '2026-08-18.json');
  ok(after.meta.asOf === '2026-08-18' && after.plan.opening.asOf === '2026-08-18',
    'canonical as-of advanced to the approved opening date');
  ok(near(cashOf(after, 'chequing-b').value, 190), 'approved Chequing B 190 is canonical');
  ok(near(Forecast.startingCashAmount(after.plan), independentCash),
    'Forecast cash independently equals 1000+190');
  ok(household(posText, 'Chequing A').as_of === '2026-08-18'
    && household(posText, 'Chequing B').as_of === '2026-08-18'
    && household(posText, 'Savings').as_of === '2026-08-18'
    && household(posText, 'Mortgage').as_of === '2026-08-18',
    'required mapped Household rows are dated the opening date');
  ok(near(Number(household(posText, 'Chequing B').balance), 190)
    && near(Number(household(posText, 'Mortgage').balance), 500000),
    'Household balances come from the approved observation, not invented rows');
  ok(near(Number(household(posText, 'Chequing A').available), 1000)
    && near(Number(household(posText, 'Chequing B').available), 600),
    'cash available follows posted balance except overdraft room, which stays structural');
  ok(/Owner-approved opening observation 2026-08-18/.test(household(posText, 'Chequing B').notes)
    && /freshness exact-day/.test(household(posText, 'Chequing B').notes),
    'Household provenance cites the approved opening evidence');
  ok(household(posText, 'Chequing B').confidence === Household.CONFIDENCE_OBSERVED
    && household(posText, 'Chequing B').confidence !== 'VERIFIED_TD',
    'exact-day opening confidence comes from the approved observation, not incumbent VERIFIED_TD');
  const computed = POS.regenerateComputedRows(after, posText);
  ok(computed.text.replace(/\r\n?/g, '\n') === posText.replace(/\r\n?/g, '\n'),
    'derived SUMMARY/CREDIT/LIQUIDITY rows already match the new canonical state');
  ok(fs.existsSync(snapPath), 'dated snapshot file was written');
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  ok(snap.asOf === '2026-08-18' && snap.schema === S.SCHEMA,
    'snapshot uses incumbent snapshot semantics and the opening date');
  const snapB = snap.accounts.find(a => a.id === 'chequing-b');
  const snapM = snap.accounts.find(a => a.id === 'mortgage');
  ok(snapB && near(snapB.balance, 190) && snapM && near(snapM.balance, 500000),
    'snapshot balances independently equal approved posted evidence');
  ok(!snap.accounts.some(a => a.id === 'wise'), 'excluded Wise is not invented into the snapshot');
  ok(household(posText, 'Wise account 1 (USD spending)').as_of === '2026-08-09'
    && near(Number(household(posText, 'Wise account 1 (USD spending)').balance), 1.92),
    'excluded standing account remains excluded and unmoved');
  const printed = JSON.parse(applied.stdout);
  ok(printed.snapshotWritten === true && printed.writesPositions === true
    && printed.canonicalWriteAuthorized === true,
    'apply result reports a complete transition, not a follow-up instruction');
  ok(hashFile(ws.dataPath) !== beforeData && hashFile(ws.positionsPath) !== beforePos,
    'canonical data and positions both changed on success');
  ok(!/4101|4102|LUNCHMONEY_ACCESS_TOKEN|Bearer /.test(posText + JSON.stringify(snap) + applied.stdout),
    'no fixture provider id or token leaked into artifacts or apply output');
}

console.log('\n=== 2. wrong/missing approval writes nothing ===');
{
  const pkt = cleanPacket();
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  const dir = tempDir();
  const ws = workspace(dir, pkt.data);
  const beforeData = hashFile(ws.dataPath);
  const beforePos = hashFile(ws.positionsPath);
  const missing = runCli([
    '--fixture', writeJson(dir, 'payload.json', pkt.payload),
    '--map', writeJson(dir, 'map.json', pkt.map),
    '--data', ws.dataPath,
    '--positions', ws.positionsPath,
    '--snapshots', ws.snapshotDir,
    '--balance-map', ws.balanceMapPath,
    '--cutover-as-of', '2026-08-18',
  ]);
  ok(missing.code === 0, 'preview without apply still exits 0');
  ok(hashFile(ws.dataPath) === beforeData && hashFile(ws.positionsPath) === beforePos
    && !fs.existsSync(path.join(ws.snapshotDir, '2026-08-18.json')),
    'preview-only writes no canonical files');
  const wrong = runCli(applyArgs(ws, pkt, '0'.repeat(64)));
  ok(wrong.code !== 0, 'wrong openingApprovalId is refused');
  ok(hashFile(ws.dataPath) === beforeData && hashFile(ws.positionsPath) === beforePos,
    'wrong approval leaves data.json and positions.csv byte-identical');
}

console.log('\n=== 3. incomplete opening evidence writes nothing ===');
{
  const pkt = cleanPacket();
  pkt.payload.accounts = matchingPostedAccounts(pkt.data, '2026-08-16');
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  ok(preview.openingCutover.cutoverWriteSupported === false && !preview.openingCutover.openingApprovalId,
    'stale posted evidence cannot propose an opening');
  const dir = tempDir();
  const ws = workspace(dir, pkt.data);
  const beforeData = hashFile(ws.dataPath);
  const beforePos = hashFile(ws.positionsPath);
  const applied = runCli(applyArgs(ws, pkt, 'f'.repeat(64)));
  ok(applied.code !== 0, 'incomplete evidence apply is refused');
  ok(hashFile(ws.dataPath) === beforeData && hashFile(ws.positionsPath) === beforePos,
    'incomplete evidence leaves prior canonical files intact');
}

console.log('\n=== 4. position construction failure writes nothing — including data.json ===');
{
  const pkt = cleanPacket();
  pkt.payload.accounts = matchingPostedAccounts(pkt.data, '2026-08-18').map(row => (
    row.id === 4102 ? Object.assign({}, row, { balance: 190 }) : row
  ));
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  const dir = tempDir();
  const ws = workspace(dir, pkt.data);
  const truncated = fixturePositions(pkt.data).split('\n').filter(line => !line.includes('Mortgage')).join('\n') + '\n';
  fs.writeFileSync(ws.positionsPath, truncated);
  const beforeData = hashFile(ws.dataPath);
  const beforePos = hashFile(ws.positionsPath);
  const applied = runCli(applyArgs(ws, pkt, preview.openingCutover.openingApprovalId));
  ok(applied.code !== 0, 'missing incumbent Mortgage Household row refuses the opening', applied.stderr.trim());
  ok(/Mortgage|incumbent Household/i.test(applied.stderr),
    'refusal names the missing Household construction', applied.stderr.trim());
  ok(hashFile(ws.dataPath) === beforeData, 'data.json was not prematurely advanced');
  ok(hashFile(ws.positionsPath) === beforePos, 'positions.csv was not partially rewritten');
  ok(!fs.existsSync(path.join(ws.snapshotDir, '2026-08-18.json')), 'no snapshot was written');
}

console.log('\n=== 5. existing snapshot conflict fails rather than rewrite history ===');
{
  const pkt = cleanPacket();
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  const dir = tempDir();
  const ws = workspace(dir, pkt.data);
  fs.writeFileSync(path.join(ws.snapshotDir, '2026-08-18.json'), `${JSON.stringify({
    schema: S.SCHEMA,
    asOf: '2026-08-18',
    role: 'historical-observation',
    currentStateAuthority: 'data.json',
    accounts: [{ id: 'chequing-a', balance: 1 }],
  }, null, 4)}\n`);
  const beforeData = hashFile(ws.dataPath);
  const beforePos = hashFile(ws.positionsPath);
  const beforeSnap = hashFile(path.join(ws.snapshotDir, '2026-08-18.json'));
  const applied = runCli(applyArgs(ws, pkt, preview.openingCutover.openingApprovalId));
  ok(applied.code !== 0, 'conflicting same-date snapshot is refused', applied.stderr.trim());
  ok(/refusing to rewrite history/.test(applied.stderr), 'refusal names history rewrite');
  ok(hashFile(ws.dataPath) === beforeData && hashFile(ws.positionsPath) === beforePos
    && hashFile(path.join(ws.snapshotDir, '2026-08-18.json')) === beforeSnap,
    'conflict leaves data.json, positions, and the existing snapshot untouched');
}

console.log('\n=== 6. excluded accounts remain excluded; pending stays exact ===');
{
  const data = makeData({
    debts: [
      { id: 'mortgage', label: 'Mortgage', institution: 'TD', balance: 500000, pending: 0, secured: true, limit: null },
      { id: 'travelvisa', label: 'Travel Visa', institution: 'TD', balance: 800, pending: 250, pendingUnknown: false, secured: false, limit: 1100 },
    ],
  });
  const map = makeProviderMap([
    { providerAccountId: 4106, collection: 'debts', id: 'travelvisa', role: 'revolving-credit' },
  ]);
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4106, name: 'Travel Visa', type: 'credit', subtype: 'credit_card',
      balance: 800, limit: 1100, evidenceDate: '2026-08-18',
    }),
  ]), [{
    id: 88071, account_id: 4106, date: '2026-08-18', amount: 342.65,
    payee: 'Merchant Pending', is_pending: true, status: 'unreviewed',
  }], completePendingCoverage());
  const { preview } = previewAt(data, payload, { accountMap: map, cutoverAsOf: '2026-08-18' });
  const travelPending = preview.openingCutover.proposedOpening.pending.find(row => row.id === 'travelvisa');
  ok(travelPending && near(travelPending.proposedValue, 342.65),
    'approved pending is the observed 342.65, not inferred from posted');
  const dir = tempDir();
  const ws = workspace(dir, data);
  const applied = runCli(applyArgs(ws, { data, map, payload }, preview.openingCutover.openingApprovalId));
  ok(applied.code === 0, 'opening with approved pending succeeds', applied.stderr.trim());
  const after = JSON.parse(fs.readFileSync(ws.dataPath, 'utf8'));
  ok(near(debtOf(after, 'travelvisa').pending, 342.65), 'canonical pending remains the approved 342.65');
  const posText = fs.readFileSync(ws.positionsPath, 'utf8');
  ok(/pending 342\.65/.test(household(posText, 'Travel Visa').notes),
    'Household pending provenance is the approved amount');
  ok(!/pending 250/.test(household(posText, 'Travel Visa').notes),
    'the previous pending 250 is not silently kept');
  ok(household(posText, 'Wise account 1 (USD spending)').as_of === '2026-08-09',
    'Wise remains excluded');
  const used = Forecast.utilisation(after.debts, null, after.plan).rows.find(r => r.id === 'travelvisa');
  ok(used && near(used.pending, 342.65), 'Forecast consumes exact approved pending, not an inferred value');
}

console.log('\n=== 7. secrets and provider ids do not enter artifacts ===');
{
  const pkt = cleanPacket();
  pkt.payload.accounts = matchingPostedAccounts(pkt.data, '2026-08-18');
  pkt.payload.bogusToken = 'not-a-real-token';
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  const dir = tempDir();
  const ws = workspace(dir, pkt.data);
  const applied = runCli(applyArgs(ws, pkt, preview.openingCutover.openingApprovalId));
  ok(applied.code === 0, 'sanitized fixture still applies', applied.stderr.trim());
  const hay = fs.readFileSync(ws.dataPath, 'utf8')
    + fs.readFileSync(ws.positionsPath, 'utf8')
    + fs.readFileSync(path.join(ws.snapshotDir, '2026-08-18.json'), 'utf8')
    + applied.stdout;
  ok(!/LUNCHMONEY_ACCESS_TOKEN/.test(hay) && !/Bearer\s+\S+/.test(hay),
    'token names do not enter output');
  ok(!/"providerAccountId"\s*:/.test(hay) && !/"providerTransactionId"\s*:/.test(hay),
    'provider ids do not enter opening artifacts');
}

console.log('\n=== 8. re-running the exact already-applied opening is a defined refusal ===');
{
  const pkt = cleanPacket();
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  const dir = tempDir();
  const ws = workspace(dir, pkt.data);
  const first = runCli(applyArgs(ws, pkt, preview.openingCutover.openingApprovalId));
  ok(first.code === 0, 'first apply succeeds', first.stderr.trim());
  const afterFirstData = hashFile(ws.dataPath);
  const afterFirstPos = hashFile(ws.positionsPath);
  const afterFirstSnap = hashFile(path.join(ws.snapshotDir, '2026-08-18.json'));
  const second = runCli(applyArgs(ws, pkt, preview.openingCutover.openingApprovalId, { payloadName: 'payload-2.json', mapName: 'map-2.json' }));
  ok(second.code !== 0, 're-apply of an already-advanced opening is refused', second.stderr.trim());
  ok(/must advance the current canonical opening|Approval does not match|No opening proposal exists/i.test(second.stderr),
    'refusal is explicit, not a silent duplicate write', second.stderr.trim());
  ok(hashFile(ws.dataPath) === afterFirstData && hashFile(ws.positionsPath) === afterFirstPos
    && hashFile(path.join(ws.snapshotDir, '2026-08-18.json')) === afterFirstSnap,
    'refusal does not duplicate Household rows or rewrite the snapshot');
  const labels = householdRows(fs.readFileSync(ws.positionsPath, 'utf8')).map(r => r.account_label);
  ok(labels.filter(l => l === 'Chequing A').length === 1, 'Chequing A still has exactly one Household row');
}

console.log('\n=== 9. mixed live/non-live artifact targets are refused ===');
{
  const pkt = cleanPacket();
  const dir = tempDir();
  const ws = workspace(dir, pkt.data);
  const liveBound = C.resolveOpeningArtifactPaths({ data: C.DEFAULT_DATA });
  ok(liveBound.positionsPath === C.DEFAULT_POSITIONS
    && liveBound.snapshotDir === C.DEFAULT_SNAPSHOTS
    && liveBound.balanceMapPath === C.DEFAULT_BALANCE_MAP,
    'live data.json binds the incumbent live positions, snapshots, and balance-map paths');
  const liveOverride = resolveError({
    data: C.DEFAULT_DATA,
    positions: ws.positionsPath,
    snapshots: ws.snapshotDir,
    balanceMap: ws.balanceMapPath,
  });
  ok(/cannot override --positions, --snapshots, or --balance-map/.test(liveOverride),
    'live data.json refuses fixture positions/snapshots/map overrides', liveOverride);
  const liveCustomMap = resolveError({
    data: C.DEFAULT_DATA,
    balanceMap: ws.balanceMapPath,
  });
  ok(/cannot override --positions, --snapshots, or --balance-map/.test(liveCustomMap),
    'live data.json refuses a custom balance map', liveCustomMap);
  const livePositionsOverride = resolveError({
    data: C.DEFAULT_DATA,
    positions: C.DEFAULT_POSITIONS,
  });
  ok(/cannot override --positions, --snapshots, or --balance-map/.test(livePositionsOverride),
    'live data.json refuses even an explicit live --positions override');
  const inversePositions = resolveError({
    data: ws.dataPath,
    positions: C.DEFAULT_POSITIONS,
    snapshots: ws.snapshotDir,
    balanceMap: ws.balanceMapPath,
  });
  ok(/cannot target live positions.csv, snapshots\/, or balance-map.json/.test(inversePositions),
    'non-live data refuses live positions.csv', inversePositions);
  const inverseSnapshots = resolveError({
    data: ws.dataPath,
    positions: ws.positionsPath,
    snapshots: C.DEFAULT_SNAPSHOTS,
    balanceMap: ws.balanceMapPath,
  });
  ok(/cannot target live positions.csv, snapshots\/, or balance-map.json/.test(inverseSnapshots),
    'non-live data refuses live snapshots/', inverseSnapshots);
  const inverseMap = resolveError({
    data: ws.dataPath,
    positions: ws.positionsPath,
    snapshots: ws.snapshotDir,
    balanceMap: C.DEFAULT_BALANCE_MAP,
  });
  ok(/cannot target live positions.csv, snapshots\/, or balance-map.json/.test(inverseMap),
    'non-live data refuses the live balance map', inverseMap);
  const missingMap = resolveError({
    data: ws.dataPath,
    positions: ws.positionsPath,
    snapshots: ws.snapshotDir,
  });
  ok(/requires --positions, --snapshots, and --balance-map/.test(missingMap),
    'non-live data no longer silently defaults to the live balance map', missingMap);

  const beforeLiveData = hashFile(LIVE_DATA);
  const beforeLivePos = hashFile(LIVE_POSITIONS);
  const beforeLiveSnap = hashFile(path.join(LIVE_SNAPSHOTS, '2026-08-16.json'));
  const cliLiveMixed = runCli([
    '--data', LIVE_DATA,
    '--positions', ws.positionsPath,
    '--snapshots', ws.snapshotDir,
    '--balance-map', ws.balanceMapPath,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve-opening', '0'.repeat(64),
  ]);
  ok(cliLiveMixed.code !== 0, 'CLI live data plus fixture artifacts is refused');
  ok(/cannot override --positions, --snapshots, or --balance-map/.test(cliLiveMixed.stderr),
    'CLI names the live artifact-set override', cliLiveMixed.stderr.trim());
  const cliInverse = runCli([
    '--data', ws.dataPath,
    '--positions', LIVE_POSITIONS,
    '--snapshots', ws.snapshotDir,
    '--balance-map', ws.balanceMapPath,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve-opening', '0'.repeat(64),
  ]);
  ok(cliInverse.code !== 0, 'CLI non-live data plus live positions is refused');
  ok(/cannot target live positions.csv, snapshots\/, or balance-map.json/.test(cliInverse.stderr),
    'CLI names the live-target refusal', cliInverse.stderr.trim());
  const cliLiveCustomMap = runCli([
    '--data', LIVE_DATA,
    '--balance-map', ws.balanceMapPath,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve-opening', '0'.repeat(64),
  ]);
  ok(cliLiveCustomMap.code !== 0, 'CLI live custom balance map is refused');
  ok(/cannot override --positions, --snapshots, or --balance-map/.test(cliLiveCustomMap.stderr),
    'CLI live custom map is refused before any canonical write', cliLiveCustomMap.stderr.trim());
  ok(hashFile(LIVE_DATA) === beforeLiveData && hashFile(LIVE_POSITIONS) === beforeLivePos
    && hashFile(path.join(LIVE_SNAPSHOTS, '2026-08-16.json')) === beforeLiveSnap,
    'mixed-target refusals leave live canonical files byte-identical');
}

console.log('\n=== 10. stale incumbent confidence is not carried onto a new opening balance ===');
{
  const data = makeData({
    debts: [
      {
        id: 'mortgage', label: 'Mortgage', institution: 'TD',
        balance: 500000, pending: 0, secured: true, limit: null,
      },
      {
        id: 'triangle', label: 'Triangle Mastercard', institution: 'Canadian Tire Bank',
        balance: 13197, pending: 0, pendingUnknown: false, secured: false, limit: 13500,
      },
    ],
  });
  const map = makeProviderMap([
    { providerAccountId: 4110, collection: 'debts', id: 'triangle', role: 'revolving-credit' },
  ]);
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4110, name: 'Triangle', type: 'credit', subtype: 'credit_card',
      balance: 13495.32, limit: 13500, evidenceDate: '2026-08-17',
    }),
  ]), [], completePendingCoverage());
  const { preview } = previewAt(data, payload, { accountMap: map, cutoverAsOf: '2026-08-18' });
  const trianglePosted = preview.openingCutover.proposedOpening.posted.find(row => row.locator === 'debts:triangle');
  ok(preview.openingCutover.cutoverWriteSupported === true && trianglePosted
    && trianglePosted.freshnessBasis === C.FRESHNESS_STATEMENT_CADENCE
    && near(trianglePosted.proposedValue, 13495.32),
    'Triangle cadence evidence is an approved opening observation, not a statement verification');
  const dir = tempDir();
  const ws = workspace(dir, data, {
    confidenceByLabel: { 'Triangle Mastercard': 'VERIFIED_STATEMENT' },
  });
  const beforePos = fs.readFileSync(ws.positionsPath, 'utf8');
  ok(household(beforePos, 'Triangle Mastercard').confidence === 'VERIFIED_STATEMENT'
    && household(beforePos, 'Chequing A').confidence === 'VERIFIED_TD',
    'incumbent Triangle confidence is VERIFIED_STATEMENT and cash is VERIFIED_TD');
  const next = clone(data);
  next.meta.asOf = '2026-08-18';
  next.plan.opening.asOf = '2026-08-18';
  for (const change of preview.openingCutover.proposedOpening.posted) {
    C.applyChange(next, {
      locator: change.locator, field: change.field,
      currentValue: change.currentValue, proposedValue: change.proposedValue,
    });
  }
  for (const change of preview.openingCutover.proposedOpening.pending || []) {
    C.applyPendingChange(next, change);
  }
  const constructed = Household.applyApprovedHouseholdRows({
    csvText: beforePos,
    balanceMap: fixtureBalanceMap(data),
    proposedOpening: preview.openingCutover.proposedOpening,
    requestedAsOf: '2026-08-18',
    nextData: next,
  });
  ok(household(constructed.text, 'Triangle Mastercard').confidence === Household.CONFIDENCE_OBSERVED_CADENCE
    && household(constructed.text, 'Triangle Mastercard').confidence !== 'VERIFIED_STATEMENT',
    'constructed Triangle confidence comes from cadence observation, not VERIFIED_STATEMENT');
  ok(household(constructed.text, 'Chequing A').confidence === Household.CONFIDENCE_OBSERVED
    && household(constructed.text, 'Chequing A').confidence !== 'VERIFIED_TD',
    'constructed cash confidence comes from exact-day observation, not VERIFIED_TD');
  const applied = runCli(applyArgs(ws, { data, map, payload }, preview.openingCutover.openingApprovalId));
  ok(applied.code === 0, 'cadence-accepted Triangle opening apply succeeds', applied.stderr.trim());
  const posText = fs.readFileSync(ws.positionsPath, 'utf8');
  ok(household(posText, 'Triangle Mastercard').confidence === Household.CONFIDENCE_OBSERVED_CADENCE
    && household(posText, 'Triangle Mastercard').confidence !== 'VERIFIED_STATEMENT'
    && near(Number(household(posText, 'Triangle Mastercard').balance), 13495.32)
    && household(posText, 'Triangle Mastercard').as_of === '2026-08-18',
    'installed Triangle row keeps the new balance/date without the old statement confidence');
  const snap = JSON.parse(fs.readFileSync(path.join(ws.snapshotDir, '2026-08-18.json'), 'utf8'));
  const snapT = snap.accounts.find(row => row.id === 'triangle');
  ok(snapT && snapT.confidence === Household.CONFIDENCE_OBSERVED_CADENCE
    && String(snapT.confidence).toLowerCase().startsWith('verified') === false,
    'snapshot history does not inherit a verified label from the incumbent statement row');
}

console.log('\n=== 11. balance-map routing drift refuses the old openingApprovalId ===');
{
  const pkt = cleanPacket();
  pkt.payload.accounts = matchingPostedAccounts(pkt.data, '2026-08-18').map(row => (
    row.id === 4102 ? Object.assign({}, row, { balance: 190 }) : row
  ));
  const originalMap = fixtureBalanceMap(pkt.data);
  const { preview } = previewAt(pkt.data, pkt.payload, {
    accountMap: pkt.map,
    cutoverAsOf: '2026-08-18',
    balanceMap: originalMap,
  });
  const approval = preview.openingCutover.openingApprovalId;
  ok(preview.openingCutover.cutoverWriteSupported === true && approval,
    'clean opening preview still issues an openingApprovalId');
  const dir = tempDir();
  const ws = workspace(dir, pkt.data);
  const drifted = JSON.parse(fs.readFileSync(ws.balanceMapPath, 'utf8'));
  const chequingA = drifted.mappings.find(row => row.canonical && row.canonical.id === 'chequing-a');
  const chequingB = drifted.mappings.find(row => row.canonical && row.canonical.id === 'chequing-b');
  ok(chequingA && chequingB, 'fixture map has Chequing A and Chequing B routing');
  const swapped = {
    accountLabel: chequingA.accountLabel,
    observationId: chequingA.observationId,
  };
  chequingA.accountLabel = chequingB.accountLabel;
  chequingA.observationId = chequingB.observationId;
  chequingB.accountLabel = swapped.accountLabel;
  chequingB.observationId = swapped.observationId;
  fs.writeFileSync(ws.balanceMapPath, `${JSON.stringify(drifted, null, 2)}\n`);
  ok(chequingA.accountLabel === 'Chequing B' && chequingB.accountLabel === 'Chequing A',
    'only the locator → Household label / observation id routing changed');
  const beforeData = hashFile(ws.dataPath);
  const beforePos = hashFile(ws.positionsPath);
  const snapPath = path.join(ws.snapshotDir, '2026-08-18.json');
  ok(!fs.existsSync(snapPath), 'no snapshot exists before the refused apply');
  const applied = runCli(applyArgs(ws, pkt, approval));
  ok(applied.code !== 0, 'apply refuses the old openingApprovalId after routing drift', applied.stderr.trim());
  ok(/does not match the recomputed opening proposal|balance-map routing/i.test(applied.stderr),
    'refusal names the approval mismatch, not a later agreement failure', applied.stderr.trim());
  ok(hashFile(ws.dataPath) === beforeData, 'routing drift leaves data.json byte-identical');
  ok(hashFile(ws.positionsPath) === beforePos, 'routing drift leaves positions.csv byte-identical');
  ok(!fs.existsSync(snapPath), 'routing drift writes no snapshot');
}

console.log('\n=== 12. live canonical files were not used as the write target ===');
{
  ok(hashFile(LIVE_DATA) === liveHash, 'live data.json is unchanged');
  ok(hashFile(LIVE_POSITIONS) === livePosHash, 'live positions.csv is unchanged');
  ok(hashFile(path.join(LIVE_SNAPSHOTS, '2026-08-16.json')) === liveSnap16Hash,
    'live 2026-08-16 snapshot history is unchanged');
  ok(liveSnap19Hash
    ? hashFile(liveSnap19Path) === liveSnap19Hash
    : !fs.existsSync(liveSnap19Path),
    'this suite did not rewrite a live 2026-08-19 snapshot');
}

console.log('\n' + (failures ? `${failures} failure(s)` : 'All B81 opening-state transition checks passed'));
if (hashFile(LIVE_DATA) !== liveHash || hashFile(LIVE_POSITIONS) !== livePosHash) {
  console.log('LIVE canonical files changed — failing closed');
  process.exit(1);
}
process.exit(failures ? 1 : 0);
