'use strict';
/* B81 same-date opening-artifact recovery.
 *
 * An already-approved canonical opening whose data.json survived, but whose
 * same-date Household positions and snapshot did not, can reconstruct ONLY
 * those two surfaces from a complete MATCH observation packet.
 *
 * Synthetic surviving-opening fixtures only. Does not write live data.json
 * or live positions.csv, and does not rewrite committed snapshots.
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-opening-recovery-'));
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

function revolving(spec) {
  return {
    id: spec.id,
    label: spec.label || spec.id,
    institution: spec.institution || 'TD',
    balance: spec.balance,
    pending: spec.pending == null ? 0 : spec.pending,
    pendingUnknown: false,
    secured: false,
    limit: spec.limit,
  };
}

function makeData(extra) {
  const asOf = (extra && extra.asOf) || '2026-08-19';
  const data = {
    meta: { asOf },
    plan: {
      windowDays: 28,
      defaults: { targetBuffer: 0 },
      startingCash: {
        breakdown: [
          { id: 'chequing-a', value: 1000 },
          { id: 'chequing-b', value: 190 },
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
      revolving({
        id: 'triangle', label: 'Triangle Mastercard',
        institution: 'Canadian Tire Bank', balance: 13495.32, pending: 0, limit: 13500,
      }),
      revolving({
        id: 'mbna', label: 'Amazon.ca Rewards Mastercard',
        institution: 'MBNA', balance: 2100.5, pending: 0, limit: 3000,
      }),
    ],
  };
  if (extra && extra.cash) {
    for (const row of data.plan.startingCash.breakdown) {
      if (extra.cash[row.id] != null) row.value = extra.cash[row.id];
    }
  }
  if (extra && extra.debts) data.debts = extra.debts;
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
      { providerAccountId: '4110', canonical: { collection: 'debts', id: 'triangle' }, atlasRole: 'revolving-credit' },
      { providerAccountId: '4111', canonical: { collection: 'debts', id: 'mbna' }, atlasRole: 'revolving-credit' },
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

function matchingPostedAccounts(data, evidenceDate, extraDates) {
  const dates = extraDates || {};
  const accounts = [
    accountRow({
      id: 4101, name: 'Chequing A', type: 'cash', subtype: 'checking',
      balance: cashOf(data, 'chequing-a').value, evidenceDate: dates.cash || evidenceDate,
    }),
    accountRow({
      id: 4102, name: 'Chequing B', type: 'cash', subtype: 'checking',
      balance: cashOf(data, 'chequing-b').value, evidenceDate: dates.cash || evidenceDate,
    }),
    accountRow({
      id: 4103, name: 'Savings', type: 'cash', subtype: 'savings',
      balance: cashOf(data, 'savings').value, evidenceDate: dates.cash || evidenceDate,
    }),
    accountRow({
      id: 4108, name: 'Mortgage', type: 'loan', subtype: 'mortgage',
      balance: debtOf(data, 'mortgage').balance, evidenceDate: dates.cash || evidenceDate,
    }),
  ];
  if (debtOf(data, 'triangle')) {
    accounts.push(accountRow({
      id: 4110, name: 'Triangle', type: 'credit', subtype: 'credit_card',
      balance: debtOf(data, 'triangle').balance, limit: 13500,
      evidenceDate: dates.triangle || '2026-08-17',
    }));
  }
  if (debtOf(data, 'mbna')) {
    accounts.push(accountRow({
      id: 4111, name: 'MBNA', type: 'credit', subtype: 'credit_card',
      balance: debtOf(data, 'mbna').balance, limit: 3000,
      evidenceDate: dates.mbna || '2026-08-08',
    }));
  }
  if (debtOf(data, 'travelvisa')) {
    accounts.push(accountRow({
      id: 4106, name: 'Travel Visa', type: 'credit', subtype: 'credit_card',
      balance: debtOf(data, 'travelvisa').balance, limit: debtOf(data, 'travelvisa').limit,
      evidenceDate: dates.cash || evidenceDate,
    }));
  }
  return accounts;
}

function makePayload(fetchedAsOf, accounts, transactions, extra) {
  return Object.assign({
    provider: 'lunchmoney',
    fetchedAt: `${fetchedAsOf}T18:00:00.000Z`,
    source: 'Synthetic surviving-opening recovery fixture. Not a live institution pull. Fixture IDs 4101–4199 are not live provider IDs.',
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

function fixturePositions(data, extra) {
  const header = 'entity,institution,account_label,account_type,side,currency,balance,credit_limit,available,interest_rate_pct,rate_basis,fixed_or_variable,structure,payment_amount,payment_frequency,next_due_date,maturity_or_renewal,annual_interest_cost,confidence,as_of,notes';
  const asOf = (extra && extra.positionsAsOf) || '2026-08-16';
  const lines = [header];
  const labels = { 'chequing-a': 'Chequing A', 'chequing-b': 'Chequing B', savings: 'Savings' };
  for (const row of data.plan.startingCash.breakdown) {
    const cols = new Array(21).fill('');
    cols[0] = 'Household'; cols[1] = 'TD'; cols[2] = labels[row.id];
    cols[3] = row.id === 'savings' ? 'Savings' : 'Chequing';
    cols[4] = 'Asset'; cols[5] = 'CAD';
    cols[6] = extra && extra.priorBalances && extra.priorBalances[row.id] != null
      ? Number(extra.priorBalances[row.id]).toFixed(2)
      : Number(row.value).toFixed(2);
    if (row.id === 'chequing-b') { cols[7] = '600.00'; cols[8] = '600.00'; }
    else cols[8] = cols[6];
    cols[12] = 'Transactional';
    cols[18] = 'VERIFIED_TD';
    cols[19] = asOf;
    cols[20] = 'incumbent captured Household row from the previous opening';
    lines.push(csvLine(cols));
  }
  for (const debt of data.debts) {
    const name = {
      mortgage: 'Mortgage', travelvisa: 'Travel Visa', cashback: 'Cash Back Visa',
      triangle: 'Triangle Mastercard', heloc: 'HELOC',
      mbna: 'Amazon.ca Rewards Mastercard',
    }[debt.id] || debt.id;
    const cols = new Array(21).fill('');
    cols[0] = 'Household';
    cols[1] = debt.institution || 'TD';
    cols[2] = name;
    cols[3] = debt.id === 'mortgage' ? 'Mortgage' : 'Credit card';
    cols[4] = 'Liability'; cols[5] = 'CAD';
    cols[6] = extra && extra.priorBalances && extra.priorBalances[debt.id] != null
      ? Number(extra.priorBalances[debt.id]).toFixed(2)
      : Number(debt.balance).toFixed(2);
    if (debt.limit != null) cols[7] = Number(debt.limit).toFixed(2);
    cols[12] = debt.secured ? 'Amortizing' : 'Revolving';
    cols[18] = debt.id === 'triangle' || debt.id === 'mbna' ? 'VERIFIED_STATEMENT' : 'VERIFIED_TD';
    cols[19] = asOf;
    cols[20] = 'incumbent captured Household row from the previous opening';
    lines.push(csvLine(cols));
  }
  const wise = new Array(21).fill('');
  wise[0] = 'Household'; wise[1] = 'Wise'; wise[2] = 'Wise account 1 (USD spending)';
  wise[3] = 'Prepaid multi-currency'; wise[4] = 'Asset'; wise[5] = 'USD';
  wise[6] = '1.92'; wise[8] = '1.92'; wise[18] = 'CALCULATED'; wise[19] = '2026-08-09';
  wise[20] = 'excluded standing account';
  lines.push(csvLine(wise));
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
      mbna: 'Amazon.ca Rewards Mastercard',
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
  const dataPath = writeJson(dir, extra && extra.dataName || 'data.json', data);
  const positionsPath = path.join(dir, extra && extra.positionsName || 'positions.csv');
  const snapshotDir = path.join(dir, extra && extra.snapshotDirName || 'snapshots');
  const balanceMapPath = writeJson(dir, extra && extra.balanceMapName || 'balance-map.json', extra && extra.balanceMap || fixtureBalanceMap(data));
  fs.writeFileSync(positionsPath, extra && extra.positionsText || fixturePositions(data, extra));
  fs.mkdirSync(snapshotDir, { recursive: true });
  return { dataPath, positionsPath, snapshotDir, balanceMapPath };
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
    recoverOpeningArtifacts: extra.recoverOpeningArtifacts === true,
    positionsPath: extra.positionsPath || null,
    snapshotDir: extra.snapshotDir || null,
    balanceMapPath: extra.balanceMapPath || null,
    dataPath: extra.dataPath || null,
    canonicalSha256: extra.canonicalSha256 || null,
  } : undefined);
}

function survivingPacket(extra) {
  const data = makeData(extra);
  const map = makeProviderMap(extra && extra.providerEntries);
  const asOf = data.meta.asOf;
  const payload = makePayload(asOf, matchingPostedAccounts(data, asOf, extra && extra.dates), extra && extra.transactions, Object.assign(
    completePendingCoverage(),
    extra && extra.payloadExtra || {}
  ));
  return { data, map, payload };
}

function recoverArgs(ws, pkt, approval, extra) {
  const args = [
    '--fixture', writeJson(path.dirname(ws.dataPath), extra && extra.payloadName || 'payload.json', pkt.payload),
    '--map', writeJson(path.dirname(ws.dataPath), extra && extra.mapName || 'map.json', pkt.map),
    '--data', ws.dataPath,
    '--positions', ws.positionsPath,
    '--snapshots', ws.snapshotDir,
    '--balance-map', ws.balanceMapPath,
    '--cutover-as-of', (extra && extra.asOf) || '2026-08-19',
    '--recover-opening-artifacts',
  ];
  if (approval) args.push('--apply', '--approve-recovery', approval);
  return args;
}

function householdRows(text) {
  return S.parsePositions(text).filter(row => row.entity === 'Household');
}

function household(text, label) {
  return householdRows(text).find(row => row.account_label === label) || null;
}

function recoveryOf(preview) {
  return preview && preview.openingCutover && preview.openingCutover.artifactRecovery;
}

console.log('=== 1. exact surviving-opening recovery succeeds ===');
{
  const pkt = survivingPacket();
  const dir = tempDir();
  const ws = workspace(dir, pkt.data, {
    priorBalances: { 'chequing-b': 200, triangle: 13197, mbna: 1800 },
  });
  const beforeData = hashFile(ws.dataPath);
  const { preview } = previewAt(pkt.data, pkt.payload, {
    accountMap: pkt.map,
    cutoverAsOf: '2026-08-19',
    recoverOpeningArtifacts: true,
    positionsPath: ws.positionsPath,
    snapshotDir: ws.snapshotDir,
    balanceMapPath: ws.balanceMapPath,
    dataPath: ws.dataPath,
    canonicalSha256: hashFile(ws.dataPath).toUpperCase(),
  });
  const recovery = recoveryOf(preview);
  ok(preview.openingCutover.status === 'READY_FOR_OWNER_REVIEW'
    && preview.openingCutover.cutoverWriteSupported === false,
    'same-date MATCH diagnostic is READY_FOR_OWNER_REVIEW and is not an opening advance');
  ok(recovery && recovery.supported === true && recovery.recoveryApprovalId
    && recovery.missingSameDateHousehold === true && recovery.missingSnapshot === true
    && recovery.writesCanonicalState === false,
    'recovery is supported for the missing positions and snapshot only');
  const previewCli = runCli(recoverArgs(ws, pkt));
  ok(previewCli.code === 0, 'recovery preview without apply exits 0', previewCli.stderr.trim());
  ok(hashFile(ws.dataPath) === beforeData
    && !fs.existsSync(path.join(ws.snapshotDir, '2026-08-19.json'))
    && household(fs.readFileSync(ws.positionsPath, 'utf8'), 'Chequing A').as_of === '2026-08-16',
    'preview writes no data.json, positions, or snapshot');
  const applied = runCli(recoverArgs(ws, pkt, recovery.recoveryApprovalId, { payloadName: 'payload-apply.json', mapName: 'map-apply.json' }));
  ok(applied.code === 0, 'approved recovery apply succeeds', applied.stderr.trim());
  const printed = JSON.parse(applied.stdout);
  ok(printed.writesCanonicalState === false && printed.byteChange === false
    && printed.writesPositions === true && printed.snapshotWritten === true,
    'apply result writes positions and snapshot and not data.json');
  ok(hashFile(ws.dataPath) === beforeData, 'surviving data.json is byte-identical after success');
  const posText = fs.readFileSync(ws.positionsPath, 'utf8');
  ok(household(posText, 'Chequing A').as_of === '2026-08-19'
    && household(posText, 'Chequing B').as_of === '2026-08-19'
    && household(posText, 'Triangle Mastercard').as_of === '2026-08-19'
    && household(posText, 'Amazon.ca Rewards Mastercard').as_of === '2026-08-19',
    'required mapped Household rows are dated the surviving opening');
  ok(near(Number(household(posText, 'Chequing B').balance), 190)
    && near(Number(household(posText, 'Triangle Mastercard').balance), 13495.32)
    && near(Number(household(posText, 'Amazon.ca Rewards Mastercard').balance), 2100.5),
    'Household balances come from the MATCH packet, not invented rows');
  const snap = JSON.parse(fs.readFileSync(path.join(ws.snapshotDir, '2026-08-19.json'), 'utf8'));
  ok(snap.asOf === '2026-08-19' && snap.schema === S.SCHEMA
    && snap.currentStateAuthority === 'data.json',
    'snapshot uses incumbent snapshot semantics');
  const independentCash = 1000 + 190;
  ok(near(Forecast.startingCashAmount(pkt.data.plan), independentCash)
    && near(Forecast.startingCashAmount(JSON.parse(fs.readFileSync(ws.dataPath, 'utf8')).plan), independentCash),
    'Forecast still consumes the unchanged surviving opening cash');
  const computed = POS.regenerateComputedRows(JSON.parse(fs.readFileSync(ws.dataPath, 'utf8')), posText);
  ok(computed.text.replace(/\r\n?/g, '\n') === posText.replace(/\r\n?/g, '\n'),
    'derived SUMMARY/CREDIT/LIQUIDITY rows match the surviving canonical state');
}

console.log('\n=== 2. data.json remains byte-identical ===');
{
  const pkt = survivingPacket();
  const dir = tempDir();
  const ws = workspace(dir, pkt.data);
  const before = fs.readFileSync(ws.dataPath);
  const { preview } = previewAt(pkt.data, pkt.payload, {
    accountMap: pkt.map, cutoverAsOf: '2026-08-19', recoverOpeningArtifacts: true,
    positionsPath: ws.positionsPath, snapshotDir: ws.snapshotDir,
    balanceMapPath: ws.balanceMapPath, dataPath: ws.dataPath,
    canonicalSha256: hashFile(ws.dataPath).toUpperCase(),
  });
  const applied = runCli(recoverArgs(ws, pkt, recoveryOf(preview).recoveryApprovalId));
  ok(applied.code === 0, 'recovery apply succeeds for byte-identity check', applied.stderr.trim());
  ok(Buffer.compare(fs.readFileSync(ws.dataPath), before) === 0,
    'data.json bytes are identical, not re-encoded');
}

console.log('\n=== 3. one balance mismatch refuses everything ===');
{
  const pkt = survivingPacket();
  pkt.payload.accounts = matchingPostedAccounts(pkt.data, '2026-08-19').map(row => (
    row.id === 4102 ? Object.assign({}, row, { balance: 175 }) : row
  ));
  const dir = tempDir();
  const ws = workspace(dir, pkt.data);
  const beforeData = hashFile(ws.dataPath);
  const beforePos = hashFile(ws.positionsPath);
  const { preview } = previewAt(pkt.data, pkt.payload, {
    accountMap: pkt.map, cutoverAsOf: '2026-08-19', recoverOpeningArtifacts: true,
    positionsPath: ws.positionsPath, snapshotDir: ws.snapshotDir,
    balanceMapPath: ws.balanceMapPath, dataPath: ws.dataPath,
    canonicalSha256: hashFile(ws.dataPath).toUpperCase(),
  });
  const recovery = recoveryOf(preview);
  ok(recovery && recovery.supported !== true
    && (recovery.blockers || []).some(b => b.code === 'recovery-posted-not-match'),
    'one posted mismatch blocks recovery', JSON.stringify(recovery && recovery.blockers));
  const applied = runCli(recoverArgs(ws, pkt, recovery && recovery.recoveryApprovalId || 'f'.repeat(64)));
  ok(applied.code !== 0, 'mismatch apply is refused', applied.stderr.trim());
  ok(hashFile(ws.dataPath) === beforeData && hashFile(ws.positionsPath) === beforePos
    && !fs.existsSync(path.join(ws.snapshotDir, '2026-08-19.json')),
    'balance mismatch writes nothing');
}

console.log('\n=== 4. one pending mismatch refuses everything ===');
{
  const data = makeData({
    debts: [
      {
        id: 'mortgage', label: 'Mortgage', institution: 'TD',
        balance: 500000, pending: 0, secured: true, limit: null,
      },
      revolving({
        id: 'triangle', label: 'Triangle Mastercard',
        institution: 'Canadian Tire Bank', balance: 13495.32, pending: 0, limit: 13500,
      }),
      revolving({
        id: 'mbna', label: 'Amazon.ca Rewards Mastercard',
        institution: 'MBNA', balance: 2100.5, pending: 0, limit: 3000,
      }),
      revolving({
        id: 'travelvisa', label: 'Travel Visa', balance: 800, pending: 250, limit: 1100,
      }),
    ],
  });
  const map = makeProviderMap([
    { providerAccountId: 4106, collection: 'debts', id: 'travelvisa', role: 'revolving-credit' },
  ]);
  const payload = makePayload('2026-08-19', matchingPostedAccounts(data, '2026-08-19'), [{
    id: 88071, account_id: 4106, date: '2026-08-19', amount: 342.65,
    payee: 'Merchant Pending', is_pending: true, status: 'unreviewed',
  }], completePendingCoverage());
  const dir = tempDir();
  const ws = workspace(dir, data);
  const beforeData = hashFile(ws.dataPath);
  const beforePos = hashFile(ws.positionsPath);
  const { preview } = previewAt(data, payload, {
    accountMap: map, cutoverAsOf: '2026-08-19', recoverOpeningArtifacts: true,
    positionsPath: ws.positionsPath, snapshotDir: ws.snapshotDir,
    balanceMapPath: ws.balanceMapPath, dataPath: ws.dataPath,
    canonicalSha256: hashFile(ws.dataPath).toUpperCase(),
  });
  const recovery = recoveryOf(preview);
  ok(recovery && recovery.supported !== true
    && (recovery.blockers || []).some(b => b.code === 'recovery-pending-not-match'),
    'pending CHANGE is not recovery MATCH', JSON.stringify(recovery && recovery.blockers));
  const applied = runCli(recoverArgs(ws, { data, map, payload }, recovery && recovery.recoveryApprovalId || 'e'.repeat(64)));
  ok(applied.code !== 0, 'pending mismatch apply is refused', applied.stderr.trim());
  ok(hashFile(ws.dataPath) === beforeData && hashFile(ws.positionsPath) === beforePos
    && !fs.existsSync(path.join(ws.snapshotDir, '2026-08-19.json')),
    'pending mismatch writes nothing');
}

console.log('\n=== 5. missing or incomplete evidence refuses ===');
{
  const pkt = survivingPacket();
  pkt.payload.accounts = matchingPostedAccounts(pkt.data, '2026-08-19').filter(row => row.id !== 4103);
  const dir = tempDir();
  const ws = workspace(dir, pkt.data);
  const beforeData = hashFile(ws.dataPath);
  const beforePos = hashFile(ws.positionsPath);
  const { preview } = previewAt(pkt.data, pkt.payload, {
    accountMap: pkt.map, cutoverAsOf: '2026-08-19', recoverOpeningArtifacts: true,
    positionsPath: ws.positionsPath, snapshotDir: ws.snapshotDir,
    balanceMapPath: ws.balanceMapPath, dataPath: ws.dataPath,
    canonicalSha256: hashFile(ws.dataPath).toUpperCase(),
  });
  ok(preview.openingCutover.status === 'BLOCKED'
    && recoveryOf(preview).supported !== true,
    'missing required posted evidence blocks recovery');
  const missing = runCli(recoverArgs(ws, pkt, 'd'.repeat(64)));
  ok(missing.code !== 0, 'missing posted evidence apply is refused');

  const incomplete = survivingPacket();
  delete incomplete.payload.pendingCoverage;
  const dir2 = tempDir();
  const ws2 = workspace(dir2, incomplete.data);
  const beforeData2 = hashFile(ws2.dataPath);
  const beforePos2 = hashFile(ws2.positionsPath);
  const { preview: preview2 } = previewAt(incomplete.data, incomplete.payload, {
    accountMap: incomplete.map, cutoverAsOf: '2026-08-19', recoverOpeningArtifacts: true,
    positionsPath: ws2.positionsPath, snapshotDir: ws2.snapshotDir,
    balanceMapPath: ws2.balanceMapPath, dataPath: ws2.dataPath,
    canonicalSha256: hashFile(ws2.dataPath).toUpperCase(),
  });
  const rec2 = recoveryOf(preview2);
  ok(rec2 && rec2.supported !== true
    && (rec2.blockers || []).some(b => b.code === 'recovery-pending-census-incomplete' || b.code === 'recovery-opening-blocked'),
    'incomplete pending census blocks recovery', JSON.stringify(rec2 && rec2.blockers));
  const applied2 = runCli(recoverArgs(ws2, incomplete, rec2 && rec2.recoveryApprovalId || 'c'.repeat(64)));
  ok(applied2.code !== 0, 'incomplete census apply is refused');
  ok(hashFile(ws.dataPath) === beforeData && hashFile(ws.positionsPath) === beforePos
    && hashFile(ws2.dataPath) === beforeData2 && hashFile(ws2.positionsPath) === beforePos2
    && !fs.existsSync(path.join(ws.snapshotDir, '2026-08-19.json'))
    && !fs.existsSync(path.join(ws2.snapshotDir, '2026-08-19.json')),
    'incomplete evidence writes nothing');

  const unmapped = survivingPacket();
  const map = fixtureBalanceMap(unmapped.data);
  map.mappings = map.mappings.filter(row => row.canonical.id !== 'savings');
  const dir3 = tempDir();
  const ws3 = workspace(dir3, unmapped.data, { balanceMap: map });
  const { preview: preview3 } = previewAt(unmapped.data, unmapped.payload, {
    accountMap: unmapped.map, cutoverAsOf: '2026-08-19', recoverOpeningArtifacts: true,
    positionsPath: ws3.positionsPath, snapshotDir: ws3.snapshotDir,
    balanceMapPath: ws3.balanceMapPath, balanceMap: map, dataPath: ws3.dataPath,
    canonicalSha256: hashFile(ws3.dataPath).toUpperCase(),
  });
  const rec3 = recoveryOf(preview3);
  ok(rec3 && rec3.supported !== true
    && (rec3.blockers || []).some(b => b.code === 'unmapped-required-account'),
    'unmapped required account blocks recovery', JSON.stringify(rec3 && rec3.blockers));
}

console.log('\n=== 6. existing conflicting snapshot refuses ===');
{
  const pkt = survivingPacket();
  const dir = tempDir();
  const ws = workspace(dir, pkt.data);
  fs.writeFileSync(path.join(ws.snapshotDir, '2026-08-19.json'), `${JSON.stringify({
    schema: S.SCHEMA,
    asOf: '2026-08-19',
    role: 'historical-observation',
    currentStateAuthority: 'data.json',
    accounts: [{ id: 'chequing-a', balance: 1 }],
  }, null, 4)}\n`);
  const beforeData = hashFile(ws.dataPath);
  const beforePos = hashFile(ws.positionsPath);
  const beforeSnap = hashFile(path.join(ws.snapshotDir, '2026-08-19.json'));
  const { preview } = previewAt(pkt.data, pkt.payload, {
    accountMap: pkt.map, cutoverAsOf: '2026-08-19', recoverOpeningArtifacts: true,
    positionsPath: ws.positionsPath, snapshotDir: ws.snapshotDir,
    balanceMapPath: ws.balanceMapPath, dataPath: ws.dataPath,
    canonicalSha256: hashFile(ws.dataPath).toUpperCase(),
  });
  const recovery = recoveryOf(preview);
  ok(recovery && recovery.supported !== true
    && (recovery.blockers || []).some(b => b.code === 'recovery-snapshot-conflict'),
    'conflicting snapshot blocks recovery', JSON.stringify(recovery && recovery.blockers));
  const applied = runCli(recoverArgs(ws, pkt, recovery && recovery.recoveryApprovalId || 'b'.repeat(64)));
  ok(applied.code !== 0, 'conflicting snapshot apply is refused', applied.stderr.trim());
  ok(hashFile(ws.dataPath) === beforeData && hashFile(ws.positionsPath) === beforePos
    && hashFile(path.join(ws.snapshotDir, '2026-08-19.json')) === beforeSnap,
    'conflict leaves data.json, positions, and the existing snapshot untouched');
}

console.log('\n=== 7. Triangle/MBNA cadence evidence remains truthful ===');
{
  const pkt = survivingPacket();
  const dir = tempDir();
  const ws = workspace(dir, pkt.data);
  const { preview } = previewAt(pkt.data, pkt.payload, {
    accountMap: pkt.map, cutoverAsOf: '2026-08-19', recoverOpeningArtifacts: true,
    positionsPath: ws.positionsPath, snapshotDir: ws.snapshotDir,
    balanceMapPath: ws.balanceMapPath, dataPath: ws.dataPath,
    canonicalSha256: hashFile(ws.dataPath).toUpperCase(),
  });
  const posted = preview.openingCutover.proposedOpening.posted;
  const triangle = posted.find(row => row.locator === 'debts:triangle');
  const mbna = posted.find(row => row.locator === 'debts:mbna');
  ok(triangle && triangle.evidenceDate === '2026-08-17'
    && triangle.freshnessBasis === C.FRESHNESS_STATEMENT_CADENCE
    && triangle.reconcileStatus === 'MATCH',
    'Triangle keeps 17 Aug cadence evidence and MATCH; evidenceDate is not rewritten');
  ok(mbna && mbna.evidenceDate === '2026-08-08'
    && mbna.freshnessBasis === C.FRESHNESS_STATEMENT_CADENCE
    && mbna.reconcileStatus === 'MATCH',
    'MBNA keeps 8 Aug cadence evidence and MATCH; evidenceDate is not rewritten');
  const applied = runCli(recoverArgs(ws, pkt, recoveryOf(preview).recoveryApprovalId));
  ok(applied.code === 0, 'cadence MATCH recovery succeeds', applied.stderr.trim());
  const posText = fs.readFileSync(ws.positionsPath, 'utf8');
  ok(household(posText, 'Triangle Mastercard').confidence === Household.CONFIDENCE_OBSERVED_CADENCE
    && household(posText, 'Triangle Mastercard').confidence !== 'VERIFIED_STATEMENT'
    && /freshness owner-approved-monthly-statement-cadence/.test(household(posText, 'Triangle Mastercard').notes)
    && /observation 2026-08-17/.test(household(posText, 'Triangle Mastercard').notes),
    'Triangle Household row inherits cadence observation confidence, not VERIFIED_STATEMENT');
  ok(household(posText, 'Amazon.ca Rewards Mastercard').confidence === Household.CONFIDENCE_OBSERVED_CADENCE
    && /freshness owner-approved-monthly-statement-cadence/.test(household(posText, 'Amazon.ca Rewards Mastercard').notes)
    && /observation 2026-08-08/.test(household(posText, 'Amazon.ca Rewards Mastercard').notes),
    'MBNA Household row inherits cadence observation confidence');
  const snap = JSON.parse(fs.readFileSync(path.join(ws.snapshotDir, '2026-08-19.json'), 'utf8'));
  const snapT = snap.accounts.find(row => row.id === 'triangle');
  const snapM = snap.accounts.find(row => row.id === 'mbna');
  ok(snapT && snapT.confidence === Household.CONFIDENCE_OBSERVED_CADENCE
    && String(snapT.confidence).toLowerCase().startsWith('verified') === false,
    'Triangle snapshot confidence is cadence observation, not verified');
  ok(snapM && snapM.confidence === Household.CONFIDENCE_OBSERVED_CADENCE,
    'MBNA snapshot confidence is cadence observation');
}

console.log('\n=== 8. no secrets or provider IDs enter artifacts ===');
{
  const pkt = survivingPacket();
  pkt.payload.bogusToken = 'not-a-real-token';
  const dir = tempDir();
  const ws = workspace(dir, pkt.data);
  const { preview } = previewAt(pkt.data, pkt.payload, {
    accountMap: pkt.map, cutoverAsOf: '2026-08-19', recoverOpeningArtifacts: true,
    positionsPath: ws.positionsPath, snapshotDir: ws.snapshotDir,
    balanceMapPath: ws.balanceMapPath, dataPath: ws.dataPath,
    canonicalSha256: hashFile(ws.dataPath).toUpperCase(),
  });
  const applied = runCli(recoverArgs(ws, pkt, recoveryOf(preview).recoveryApprovalId));
  ok(applied.code === 0, 'sanitized fixture still recovers', applied.stderr.trim());
  const hay = fs.readFileSync(ws.dataPath, 'utf8')
    + fs.readFileSync(ws.positionsPath, 'utf8')
    + fs.readFileSync(path.join(ws.snapshotDir, '2026-08-19.json'), 'utf8')
    + applied.stdout;
  ok(!/LUNCHMONEY_ACCESS_TOKEN/.test(hay) && !/Bearer\s+\S+/.test(hay)
    && !/SITE_PASSWORD/.test(hay) && !/SESSION_SECRET/.test(hay),
    'token names do not enter recovery output');
  ok(!/"providerAccountId"\s*:/.test(hay) && !/"providerTransactionId"\s*:/.test(hay)
    && !/\b4101\b/.test(fs.readFileSync(ws.positionsPath, 'utf8'))
    && !/\b4101\b/.test(fs.readFileSync(path.join(ws.snapshotDir, '2026-08-19.json'), 'utf8')),
    'provider ids do not enter recovered positions or snapshot');
}

console.log('\n=== 9. retry after successful recovery is refused cleanly ===');
{
  const pkt = survivingPacket();
  const dir = tempDir();
  const ws = workspace(dir, pkt.data);
  const { preview } = previewAt(pkt.data, pkt.payload, {
    accountMap: pkt.map, cutoverAsOf: '2026-08-19', recoverOpeningArtifacts: true,
    positionsPath: ws.positionsPath, snapshotDir: ws.snapshotDir,
    balanceMapPath: ws.balanceMapPath, dataPath: ws.dataPath,
    canonicalSha256: hashFile(ws.dataPath).toUpperCase(),
  });
  const first = runCli(recoverArgs(ws, pkt, recoveryOf(preview).recoveryApprovalId));
  ok(first.code === 0, 'first recovery succeeds', first.stderr.trim());
  const afterData = hashFile(ws.dataPath);
  const afterPos = hashFile(ws.positionsPath);
  const afterSnap = hashFile(path.join(ws.snapshotDir, '2026-08-19.json'));
  const second = runCli(recoverArgs(ws, pkt, recoveryOf(preview).recoveryApprovalId, {
    payloadName: 'payload-2.json', mapName: 'map-2.json',
  }));
  ok(second.code !== 0, 'retry apply is refused', second.stderr.trim());
  ok(/already present and agree|not supported|No artifact-recovery proposal/i.test(second.stderr),
    'retry names that recovery is already complete, not a silent rewrite', second.stderr.trim());
  ok(hashFile(ws.dataPath) === afterData && hashFile(ws.positionsPath) === afterPos
    && hashFile(path.join(ws.snapshotDir, '2026-08-19.json')) === afterSnap,
    'retry leaves recovered artifacts byte-identical');
  const labels = householdRows(fs.readFileSync(ws.positionsPath, 'utf8')).map(r => r.account_label);
  ok(labels.filter(l => l === 'Chequing A').length === 1, 'Chequing A still has exactly one Household row');
}

console.log('\n=== 10. foreign approvals cannot authorize recovery ===');
{
  const pkt = survivingPacket();
  const dir = tempDir();
  const ws = workspace(dir, pkt.data);
  const beforeData = hashFile(ws.dataPath);
  const beforePos = hashFile(ws.positionsPath);
  const { preview } = previewAt(pkt.data, pkt.payload, {
    accountMap: pkt.map, cutoverAsOf: '2026-08-19', recoverOpeningArtifacts: true,
    positionsPath: ws.positionsPath, snapshotDir: ws.snapshotDir,
    balanceMapPath: ws.balanceMapPath, dataPath: ws.dataPath,
    canonicalSha256: hashFile(ws.dataPath).toUpperCase(),
  });
  const opening = runCli([
    '--fixture', writeJson(dir, 'payload-open.json', pkt.payload),
    '--map', writeJson(dir, 'map-open.json', pkt.map),
    '--data', ws.dataPath,
    '--positions', ws.positionsPath,
    '--snapshots', ws.snapshotDir,
    '--balance-map', ws.balanceMapPath,
    '--cutover-as-of', '2026-08-19',
    '--recover-opening-artifacts',
    '--apply', '--approve-opening', recoveryOf(preview).recoveryApprovalId,
  ]);
  ok(opening.code !== 0, 'openingApprovalId flag cannot be used as recovery apply');
  const posted = runCli(recoverArgs(ws, pkt, preview.previewId, { payloadName: 'payload-posted.json' }));
  ok(posted.code !== 0, 'previewId cannot authorize recovery');
  ok(hashFile(ws.dataPath) === beforeData && hashFile(ws.positionsPath) === beforePos
    && !fs.existsSync(path.join(ws.snapshotDir, '2026-08-19.json')),
    'foreign approvals write nothing');
}

console.log('\n=== 11. recoveryApprovalId binds exact proposed artifact bytes ===');
{
  const pkt = survivingPacket();
  const dir = tempDir();
  const ws = workspace(dir, pkt.data, {
    priorBalances: { 'chequing-b': 200, triangle: 13197, mbna: 1800 },
  });
  const beforeData = hashFile(ws.dataPath);
  const { preview } = previewAt(pkt.data, pkt.payload, {
    accountMap: pkt.map, cutoverAsOf: '2026-08-19', recoverOpeningArtifacts: true,
    positionsPath: ws.positionsPath, snapshotDir: ws.snapshotDir,
    balanceMapPath: ws.balanceMapPath, dataPath: ws.dataPath,
    canonicalSha256: hashFile(ws.dataPath).toUpperCase(),
  });
  const oldId = recoveryOf(preview) && recoveryOf(preview).recoveryApprovalId;
  ok(!!oldId && recoveryOf(preview).supported === true,
    'preview issued a recoveryApprovalId for the exact artifact proposal');

  const originalPos = fs.readFileSync(ws.positionsPath, 'utf8');
  const mutated = originalPos.replace('Household,TD,Chequing A,', 'Household,TD Canada Trust,Chequing A,');
  ok(mutated !== originalPos, 'incumbent Chequing A institution field changed');
  fs.writeFileSync(ws.positionsPath, mutated);
  const afterMutatePos = hashFile(ws.positionsPath);
  ok(hashFile(ws.dataPath) === beforeData, 'incumbent mutation does not touch data.json');

  const { preview: preview2 } = previewAt(pkt.data, pkt.payload, {
    accountMap: pkt.map, cutoverAsOf: '2026-08-19', recoverOpeningArtifacts: true,
    positionsPath: ws.positionsPath, snapshotDir: ws.snapshotDir,
    balanceMapPath: ws.balanceMapPath, dataPath: ws.dataPath,
    canonicalSha256: hashFile(ws.dataPath).toUpperCase(),
  });
  const drifted = recoveryOf(preview2);
  ok(drifted && drifted.supported === true && drifted.recoveryApprovalId
    && drifted.recoveryApprovalId !== oldId,
    'structural incumbent drift changes recoveryApprovalId without touching evidence or routing');

  const applied = runCli(recoverArgs(ws, pkt, oldId, {
    payloadName: 'payload-stale-approval.json', mapName: 'map-stale-approval.json',
  }));
  ok(applied.code !== 0, 'old recoveryApprovalId is refused after incumbent structural drift', applied.stderr.trim());
  ok(hashFile(ws.dataPath) === beforeData
    && hashFile(ws.positionsPath) === afterMutatePos
    && !fs.existsSync(path.join(ws.snapshotDir, '2026-08-19.json')),
    'stale recovery approval writes nothing');
}

console.log('\n=== 11b. a blank same-date positions balance is unknown, never a posted 0 ===');
{
  // Invented: Chequing B is canonically and observably 0.00. A same-date
  // Household row already exists for it with a BLANK balance cell.
  // Number('') is 0, so a blank cell used to count as agreeing with the
  // posted 0; a blank is unknown and must block recovery as a conflict.
  const pkt = survivingPacket({ cash: { 'chequing-b': 0 } });
  const dir = tempDir();
  const sameDate = fixturePositions(pkt.data, { positionsAsOf: '2026-08-19' });
  const blanked = sameDate.split('\n').map((line) => {
    if (!line.startsWith('Household,') || !line.includes(',Chequing B,')) return line;
    const cols = line.split(',');
    cols[6] = '';
    return cols.join(',');
  }).join('\n');
  ok(blanked !== sameDate, 'fixture: the Chequing B same-date balance cell is blank');
  const ws = workspace(dir, pkt.data, { positionsText: blanked });
  const beforePos = hashFile(ws.positionsPath);
  const { preview } = previewAt(pkt.data, pkt.payload, {
    accountMap: pkt.map, cutoverAsOf: '2026-08-19', recoverOpeningArtifacts: true,
    positionsPath: ws.positionsPath, snapshotDir: ws.snapshotDir,
    balanceMapPath: ws.balanceMapPath, dataPath: ws.dataPath,
    canonicalSha256: hashFile(ws.dataPath).toUpperCase(),
  });
  const recovery = recoveryOf(preview);
  ok(recovery && recovery.supported !== true
    && (recovery.blockers || []).some(b => b.code === 'recovery-positions-conflict'
      && /Chequing B/.test(b.explanation || '')),
    'a blank same-date balance is a conflict, not a match with posted 0',
    JSON.stringify(recovery && { supported: recovery.supported, blockers: (recovery.blockers || []).map(b => b.code) }));
  const applied = runCli(recoverArgs(ws, pkt, recovery && recovery.recoveryApprovalId || 'f'.repeat(64)));
  ok(applied.code !== 0 && hashFile(ws.positionsPath) === beforePos
    && !fs.existsSync(path.join(ws.snapshotDir, '2026-08-19.json')),
    'the blank-cell recovery writes nothing', applied.stderr.trim());
  // Control: the same packet with a real 0.00 cell still agrees.
  const dir2 = tempDir();
  const ws2 = workspace(dir2, pkt.data, { positionsText: sameDate });
  const control = recoveryOf(previewAt(pkt.data, pkt.payload, {
    accountMap: pkt.map, cutoverAsOf: '2026-08-19', recoverOpeningArtifacts: true,
    positionsPath: ws2.positionsPath, snapshotDir: ws2.snapshotDir,
    balanceMapPath: ws2.balanceMapPath, dataPath: ws2.dataPath,
    canonicalSha256: hashFile(ws2.dataPath).toUpperCase(),
  }).preview);
  ok(control && !(control.blockers || []).some(b => b.code === 'recovery-positions-conflict'),
    'control: a recorded 0.00 same-date cell is not a conflict',
    JSON.stringify(control && (control.blockers || []).map(b => b.code)));
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

console.log('\n' + (failures ? `${failures} failure(s)` : 'All B81 opening-artifact recovery checks passed'));
if (hashFile(LIVE_DATA) !== liveHash || hashFile(LIVE_POSITIONS) !== livePosHash) {
  console.log('LIVE canonical files changed — failing closed');
  process.exit(1);
}
process.exit(failures ? 1 : 0);
