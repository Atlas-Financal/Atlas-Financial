'use strict';
/* B81 bounded owner-approved canonical opening cutover.
 *
 * Proves a clean candidate opening becomes canonical only through one
 * exact openingApprovalId. previewId and pending cutoverApprovalId cannot
 * authorize that write. Does not apply live Aug. 18/19 household values.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const C = require('../scripts/canonical-refresh.js');
const Forecast = require('../public/forecast.js');

const ROOT = path.join(__dirname, '..');
const LIVE_DATA = path.join(ROOT, 'data.json');
const SCRIPT = path.join(ROOT, 'scripts', 'canonical-refresh.js');
const B81_FIXTURE = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'lunchmoney-b81-refresh.json');
const B81_MAP = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'b81-account-map.json');

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
const liveData = JSON.parse(fs.readFileSync(LIVE_DATA, 'utf8'));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-opening-cutover-'));
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
      opening: {
        asOf,
        representedEvents: (extra && extra.priorRepresented) || [],
      },
      nextDollar: { target: 'cashback', provenance: 'derived' },
      income: (extra && extra.income) || [],
      obligations: (extra && extra.obligations) || [],
      bills: (extra && extra.bills) || [],
      commitments: (extra && extra.commitments) || [],
    },
    debts: (extra && extra.debts) || [
      {
        id: 'mortgage',
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
  return data;
}

function makeMap(entries) {
  return {
    schema: 'atlas-provider-account-map/v1',
    provider: 'lunchmoney',
    scope: 'fixture',
    mappings: [
      { providerAccountId: '4101', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
      { providerAccountId: '4102', canonical: { collection: 'cash', id: 'chequing-b' }, atlasRole: 'household-cash' },
      { providerAccountId: '4103', canonical: { collection: 'cash', id: 'savings' }, atlasRole: 'household-cash' },
      { providerAccountId: '4108', canonical: { collection: 'debts', id: 'mortgage' }, atlasRole: 'mortgage' },
    ].concat(entries.map(entry => ({
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

function makePayload(fetchedAsOf, accounts, transactions, extra) {
  return Object.assign({
    provider: 'lunchmoney',
    fetchedAt: `${fetchedAsOf}T18:00:00.000Z`,
    source: 'Synthetic opening-cutover writer fixture. Not a live institution pull. Fixture IDs 4101–4199 are not live provider IDs.',
    accounts,
    transactions: transactions || [],
  }, extra || {});
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
    balanceMap: extra.balanceMap || fixtureBalanceMapFor(data),
  } : undefined);
}

function revolving(spec) {
  return {
    id: spec.id,
    label: spec.label || spec.id,
    balance: spec.balance,
    pending: spec.pending == null ? null : spec.pending,
    pendingUnknown: spec.pendingUnknown === true,
    secured: false,
    limit: spec.limit,
  };
}

function payrollIdentity() {
  return {
    rules: [{
      eventId: 'payroll',
      payeePattern: 'SEASPAN',
      atlasAccountId: 'chequing-a',
      direction: 'credit',
    }],
    billPaymentPayees: [],
  };
}

const CASH_POSITION_LABEL = {
  'chequing-a': 'Chequing A',
  'chequing-b': 'Chequing B',
  savings: 'Savings',
};
const DEBT_POSITION_LABEL = {
  mortgage: 'Mortgage',
  travelvisa: 'Travel Visa',
  cashback: 'Cash Back Visa',
  tdcc: 'Credit Card',
  triangle: 'Triangle Mastercard',
  mbna: 'Amazon.ca Rewards Mastercard',
  heloc: 'HELOC',
};

function fixturePositionsFor(data) {
  const header = 'entity,institution,account_label,account_type,side,currency,balance,credit_limit,available,interest_rate_pct,rate_basis,fixed_or_variable,structure,payment_amount,payment_frequency,next_due_date,maturity_or_renewal,annual_interest_cost,confidence,as_of,notes';
  const asOf = data.meta.asOf;
  const lines = [header];
  const rowLine = cols => cols.map(v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',');
  for (const row of data.plan.startingCash.breakdown) {
    const cols = new Array(21).fill('');
    cols[0] = 'Household'; cols[1] = 'TD';
    cols[2] = CASH_POSITION_LABEL[row.id] || row.id;
    cols[3] = row.id === 'savings' ? 'Savings' : 'Chequing';
    cols[4] = 'Asset'; cols[5] = 'CAD'; cols[6] = Number(row.value).toFixed(2);
    if (row.id === 'chequing-b') { cols[7] = '600.00'; cols[8] = '600.00'; }
    else cols[8] = Number(row.value).toFixed(2);
    cols[18] = 'VERIFIED_TD'; cols[19] = asOf; cols[20] = 'incumbent fixture Household row';
    lines.push(rowLine(cols));
  }
  for (const debt of data.debts) {
    const cols = new Array(21).fill('');
    cols[0] = 'Household'; cols[1] = 'TD';
    cols[2] = DEBT_POSITION_LABEL[debt.id] || debt.id;
    cols[3] = debt.id === 'mortgage' ? 'Mortgage' : (debt.id === 'heloc' ? 'Home equity line' : 'Credit card');
    cols[4] = 'Liability'; cols[5] = 'CAD'; cols[6] = Number(debt.balance).toFixed(2);
    if (debt.limit != null) cols[7] = Number(debt.limit).toFixed(2);
    cols[18] = 'VERIFIED_TD'; cols[19] = asOf; cols[20] = 'incumbent fixture Household row';
    lines.push(rowLine(cols));
  }
  const wise = new Array(21).fill('');
  wise[0] = 'Household'; wise[1] = 'Wise'; wise[2] = 'Wise account 1 (USD spending)';
  wise[3] = 'Prepaid multi-currency'; wise[4] = 'Asset'; wise[5] = 'USD'; wise[6] = '1.92';
  wise[8] = '1.92'; wise[18] = 'CALCULATED'; wise[19] = '2026-08-09';
  wise[20] = 'excluded standing account';
  lines.push(rowLine(wise));
  return `${lines.join('\n')}\n`;
}

function fixtureBalanceMapFor(data) {
  const mappings = [];
  for (const row of data.plan.startingCash.breakdown) {
    mappings.push({
      observationId: `pos-${row.id}`,
      accountLabel: CASH_POSITION_LABEL[row.id] || row.id,
      canonical: { collection: 'cash', id: row.id },
    });
  }
  for (const debt of data.debts) {
    mappings.push({
      observationId: `pos-${debt.id}`,
      accountLabel: DEBT_POSITION_LABEL[debt.id] || debt.id,
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

function writeOpeningWorkspace(dir, data) {
  const positionsPath = path.join(dir, 'positions.csv');
  const snapshotDir = path.join(dir, 'snapshots');
  const mapPath = path.join(dir, 'balance-map.json');
  fs.writeFileSync(positionsPath, fixturePositionsFor(data));
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(mapPath, `${JSON.stringify(fixtureBalanceMapFor(data), null, 2)}\n`);
  return { positionsPath, snapshotDir, mapPath };
}

function applyOpening(dir, data, payload, map, approval, extra) {
  const dest = writeJson(dir, extra && extra.dataName || 'data.json', data);
  const workspace = writeOpeningWorkspace(dir, data);
  const before = hashFile(dest);
  const identity = extra && extra.identity
    ? extra.identity
    : { rules: [], billPaymentPayees: [] };
  const applied = runCli([
    '--fixture', writeJson(dir, extra && extra.payloadName || 'payload.json', payload),
    '--map', writeJson(dir, extra && extra.mapName || 'map.json', map),
    '--identity', writeJson(dir, extra && extra.identityName || 'identity.json', identity),
    '--data', dest,
    '--positions', workspace.positionsPath,
    '--snapshots', workspace.snapshotDir,
    '--balance-map', workspace.mapPath,
    '--cutover-as-of', (extra && extra.asOf) || '2026-08-18',
    '--apply', '--approve-opening', approval,
  ]);
  return { dest, before, applied, after: JSON.parse(fs.readFileSync(dest, 'utf8')), workspace };
}

function cleanMatchPacket() {
  const data = makeData();
  const map = makeMap([]);
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18'));
  return { data, map, payload };
}

function postedChangePacket() {
  const data = makeData();
  const map = makeMap([]);
  const accounts = matchingPostedAccounts(data, '2026-08-18').map(row => (
    row.id === 4102 ? Object.assign({}, row, { balance: 190 }) : row
  ));
  return { data, map, payload: makePayload('2026-08-18', accounts) };
}

function travelPendingPacket() {
  const data = makeData({
    debts: [
      { id: 'mortgage', balance: 500000, pending: 0, secured: true, interestTreatment: 'paid-in-payment', limit: null },
      revolving({ id: 'travelvisa', label: 'Travel Visa', balance: 800, pending: 250, limit: 1100 }),
    ],
  });
  const map = makeMap([{ providerAccountId: 4106, collection: 'debts', id: 'travelvisa', role: 'revolving-credit' }]);
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4106, name: 'Travel Visa', type: 'credit', subtype: 'credit_card',
      balance: 800, limit: 1100, evidenceDate: '2026-08-18',
    }),
  ]), [{
    id: 88061,
    account_id: 4106,
    date: '2026-08-18',
    amount: 342.65,
    payee: 'Merchant Pending',
    is_pending: true,
    status: 'unreviewed',
  }], completePendingCoverage());
  return { data, map, payload };
}

function unknownZeroPacket() {
  const data = makeData({
    debts: [
      { id: 'mortgage', balance: 500000, pending: 0, secured: true, interestTreatment: 'paid-in-payment', limit: null },
      revolving({ id: 'cashback', label: 'Cash Back', balance: 4000, pending: null, pendingUnknown: true, limit: 5000 }),
    ],
  });
  const map = makeMap([{ providerAccountId: 4105, collection: 'debts', id: 'cashback', role: 'revolving-credit' }]);
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4105, name: 'Cash Back', type: 'credit', subtype: 'credit_card',
      balance: 4000, limit: 5000, evidenceDate: '2026-08-18',
    }),
  ]), [], completePendingCoverage());
  return { data, map, payload };
}

function fullSyntheticPacket() {
  const requested = '2026-08-18';
  const data = makeData({
    priorRepresented: [{ id: 'old-payroll', date: '2026-08-16' }],
    income: [{
      id: 'payroll',
      label: 'Payroll',
      frequency: 'once',
      date: requested,
      amount: 1000,
      confidence: 'confirmed',
    }],
    bills: [{
      id: 'owed',
      label: 'Unresolved once obligation',
      frequency: 'once',
      date: '2026-08-16',
      amount: 100,
      confidence: 'confirmed',
    }],
    commitments: [{
      id: 'settled-camp',
      label: 'Settled camp',
      amount: 400,
      date: '2026-08-14',
      settledOn: '2026-08-14',
      confidence: 'confirmed',
    }],
    debts: [
      { id: 'mortgage', balance: 500000, pending: 0, secured: true, interestTreatment: 'paid-in-payment', limit: null },
      revolving({ id: 'travelvisa', label: 'Travel Visa', balance: 800, pending: 250, limit: 1100 }),
      revolving({ id: 'cashback', label: 'Cash Back', balance: 4000, pending: null, pendingUnknown: true, limit: 5000 }),
    ],
  });
  const map = makeMap([
    { providerAccountId: 4106, collection: 'debts', id: 'travelvisa', role: 'revolving-credit' },
    { providerAccountId: 4105, collection: 'debts', id: 'cashback', role: 'revolving-credit' },
  ]);
  const accounts = matchingPostedAccounts(data, requested).map(row => (
    row.id === 4102 ? Object.assign({}, row, { balance: 190 }) : row
  )).concat([
    accountRow({
      id: 4106, name: 'Travel Visa', type: 'credit', subtype: 'credit_card',
      balance: 800, limit: 1100, evidenceDate: requested,
    }),
    accountRow({
      id: 4105, name: 'Cash Back', type: 'credit', subtype: 'credit_card',
      balance: 4000, limit: 5000, evidenceDate: requested,
    }),
  ]);
  const payload = makePayload(requested, accounts, [{
    id: 88061,
    account_id: 4106,
    date: requested,
    amount: 342.65,
    payee: 'Merchant Pending',
    is_pending: true,
    status: 'unreviewed',
  }, {
    id: 88010,
    account_id: 4101,
    date: requested,
    amount: -1000,
    payee: 'SEASPAN PAYROLL',
    is_pending: false,
    status: 'reviewed',
  }], completePendingCoverage());
  return { data, map, payload, identity: payrollIdentity(), requested };
}

console.log('=== 1. ordinary posted B81 writer still works unchanged ===');
{
  const pinned16 = JSON.parse(execFileSync('git', ['show', '28d08a12:data.json'], { encoding: 'utf8' }));
  const identity = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'connectivity', 'transaction-identity.json'), 'utf8'));
  const first = C.previewFrom({
    provider: 'lunchmoney',
    payload: JSON.parse(fs.readFileSync(B81_FIXTURE, 'utf8')),
    accountMap: JSON.parse(fs.readFileSync(B81_MAP, 'utf8')),
    data: pinned16,
    identity,
    fetchedAt: JSON.parse(fs.readFileSync(B81_FIXTURE, 'utf8')).fetchedAt,
  });
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', pinned16);
  const applied = runCli([
    '--fixture', B81_FIXTURE, '--map', B81_MAP, '--data', dest,
    '--apply', '--approve', first.preview.previewId,
  ]);
  ok(applied.code === 0, 'ordinary posted apply still exits 0', applied.stderr.trim());
  const after = JSON.parse(fs.readFileSync(dest, 'utf8'));
  ok(near(cashOf(after, 'chequing-b').value, 922.05), 'posted writer still applies Chequing B 932.05 → 922.05');
  ok(after.meta.asOf === pinned16.meta.asOf && after.plan.opening.asOf === pinned16.plan.opening.asOf,
    'posted writer still does not move as-of');
}

console.log('\n=== 2. #109 pending writer still works unchanged ===');
{
  const pkt = travelPendingPacket();
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', pkt.data);
  const applied = runCli([
    '--fixture', writeJson(dir, 'payload.json', pkt.payload),
    '--map', writeJson(dir, 'map.json', pkt.map),
    '--data', dest,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve-cutover', preview.openingCutover.cutoverApprovalId,
  ]);
  ok(applied.code === 0, 'pending writer still writes Travel Visa pending', applied.stderr.trim());
  const after = JSON.parse(fs.readFileSync(dest, 'utf8'));
  ok(near(debtOf(after, 'travelvisa').pending, 342.65), 'pending writer still applies 250 → 342.65');
  ok(after.meta.asOf === '2026-08-16' && after.plan.opening.asOf === '2026-08-16',
    'pending writer still does not advance the opening');
}

console.log('\n=== 3. neither previewId nor pending cutoverApprovalId can authorize an opening ===');
{
  const pkt = postedChangePacket();
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  ok(preview.openingCutover.cutoverWriteSupported === true && preview.openingCutover.openingApprovalId,
    'clean posted CHANGE packet can propose an opening');
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', pkt.data);
  const before = hashFile(dest);
  const viaPreview = runCli([
    '--fixture', writeJson(dir, 'payload.json', pkt.payload),
    '--map', writeJson(dir, 'map.json', pkt.map),
    '--data', dest,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve-opening', preview.previewId,
  ]);
  ok(viaPreview.code !== 0, 'previewId cannot authorize an opening');
  ok(/previewId/.test(viaPreview.stderr), 'refusal names previewId', viaPreview.stderr.trim());
  const pendingPkt = travelPendingPacket();
  const pendingPreview = previewAt(pendingPkt.data, pendingPkt.payload, {
    accountMap: pendingPkt.map, cutoverAsOf: '2026-08-18',
  });
  const pendingDest = writeJson(dir, 'pending-data.json', pendingPkt.data);
  const pendingBefore = hashFile(pendingDest);
  const viaPending = runCli([
    '--fixture', writeJson(dir, 'pending-payload.json', pendingPkt.payload),
    '--map', writeJson(dir, 'pending-map.json', pendingPkt.map),
    '--data', pendingDest,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve-opening', pendingPreview.preview.openingCutover.cutoverApprovalId,
  ]);
  ok(viaPending.code !== 0, 'pending cutoverApprovalId cannot authorize an opening');
  ok(/cutoverApprovalId|pending/i.test(viaPending.stderr), 'refusal names the pending approval',
    viaPending.stderr.trim());
  ok(hashFile(dest) === before && hashFile(pendingDest) === pendingBefore,
    'wrong-contract refusals leave both targets byte-identical');
}

console.log('\n=== 4. clean exact-date MATCH opening can be proposed ===');
{
  const pkt = cleanMatchPacket();
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  const cutover = preview.openingCutover;
  ok(cutover.status === 'READY_FOR_OWNER_REVIEW', 'clean MATCH is READY_FOR_OWNER_REVIEW');
  ok(cutover.writesOpening === false, 'preview still declares writesOpening false');
  ok(cutover.cutoverWriteSupported === true, 'clean MATCH is opening-writable');
  ok(cutover.openingApprovalId && cutover.openingApprovalId !== preview.previewId,
    'openingApprovalId is distinct from previewId');
  const mortgage = cutover.proposedOpening.posted.find(row => row.locator === 'debts:mortgage');
  ok(mortgage && near(mortgage.currentValue, 500000) && near(mortgage.proposedValue, 500000)
    && mortgage.freshnessBasis === C.FRESHNESS_EXACT_DAY,
    'MATCH mortgage participates in the proposed opening');
}

console.log('\n=== 5. clean posted CHANGE participates in the opening ===');
{
  const independentCash = 1000 + 190;
  const pkt = postedChangePacket();
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  const posted = preview.openingCutover.proposedOpening.posted.find(row => row.locator === 'cash:chequing-b');
  ok(posted && near(posted.currentValue, 200) && near(posted.proposedValue, 190),
    'proposed opening binds Chequing B 200 → 190');
  const dir = tempDir();
  const { dest, applied, after } = applyOpening(dir, pkt.data, pkt.payload, pkt.map,
    preview.openingCutover.openingApprovalId);
  ok(applied.code === 0, 'exact opening approval writes the posted CHANGE', applied.stderr.trim());
  ok(near(cashOf(after, 'chequing-b').value, 190), 'Chequing B is 190 after opening write');
  ok(near(Forecast.startingCashAmount(after.plan), independentCash),
    'Forecast cash independently equals chequing-only 1190');
  ok(hashFile(dest) !== hashFile(writeJson(dir, 'before.json', pkt.data)),
    'successful opening changes the temp file');
}

console.log('\n=== 6. pending known → numeric participates ===');
{
  const pkt = travelPendingPacket();
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  const pending = preview.openingCutover.proposedOpening.pending.find(row => row.locator === 'debts:travelvisa#pending');
  ok(pending && near(pending.currentValue, 250) && near(pending.proposedValue, 342.65),
    'proposed opening binds Travel Visa 250 → 342.65');
  const dir = tempDir();
  const { applied, after } = applyOpening(dir, pkt.data, pkt.payload, pkt.map,
    preview.openingCutover.openingApprovalId);
  ok(applied.code === 0, 'opening write applies known pending CHANGE', applied.stderr.trim());
  ok(near(debtOf(after, 'travelvisa').pending, 342.65), 'Travel Visa pending is 342.65');
  ok(after.meta.asOf === '2026-08-18' && after.plan.opening.asOf === '2026-08-18',
    'opening dates advanced with the pending CHANGE');
}

console.log('\n=== 7. pending UNKNOWN → proven zero participates ===');
{
  const independentRoom = Math.round((5000 - 4000) * 100) / 100;
  ok(near(independentRoom, 1000), 'independent Cash Back room after proven 0 is 1000');
  const pkt = unknownZeroPacket();
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  const pending = preview.openingCutover.proposedOpening.pending.find(row => row.locator === 'debts:cashback#pending');
  ok(pending && pending.currentUnknown === true && near(pending.proposedValue, 0)
    && pending.proof === 'is_pending-unbounded',
    'proposed opening binds UNKNOWN → proven 0');
  const dir = tempDir();
  const { applied, after } = applyOpening(dir, pkt.data, pkt.payload, pkt.map,
    preview.openingCutover.openingApprovalId);
  ok(applied.code === 0, 'opening write applies UNKNOWN → 0', applied.stderr.trim());
  const cashback = debtOf(after, 'cashback');
  ok(cashback.pendingUnknown === false && near(cashback.pending, 0),
    'UNKNOWN marker is cleared and pending is 0');
  const used = Forecast.utilisation(after.debts, null, after.plan).rows.find(r => r.id === 'cashback');
  ok(used && near(used.pending, 0) && near(used.used, 4000) && near(used.available, independentRoom),
    'Forecast utilisation consumes proven pending 0');
}

console.log('\n=== 8. incomplete pending coverage blocks the opening ===');
{
  const pkt = unknownZeroPacket();
  delete pkt.payload.pendingCoverage;
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  ok(preview.openingCutover.cutoverWriteSupported === false
    && !preview.openingCutover.openingApprovalId,
    'incomplete coverage cannot propose an opening');
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', pkt.data);
  const before = hashFile(dest);
  const applied = runCli([
    '--fixture', writeJson(dir, 'payload.json', pkt.payload),
    '--map', writeJson(dir, 'map.json', pkt.map),
    '--data', dest,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve-opening', 'f'.repeat(64),
  ]);
  ok(applied.code !== 0, 'incomplete coverage opening apply is refused');
  ok(hashFile(dest) === before, 'incomplete-coverage refusal is byte-identical');
  ok(debtOf(JSON.parse(fs.readFileSync(dest, 'utf8')), 'cashback').pendingUnknown === true,
    'UNKNOWN remains UNKNOWN');
}

console.log('\n=== 9. pending conflict blocks the opening ===');
{
  const data = makeData({
    debts: [
      { id: 'mortgage', balance: 500000, pending: 0, secured: true, interestTreatment: 'paid-in-payment', limit: null },
      revolving({ id: 'travelvisa', balance: 800, pending: 250, limit: 1100 }),
    ],
  });
  const map = makeMap([
    { providerAccountId: 4106, collection: 'debts', id: 'travelvisa', role: 'revolving-credit' },
    { providerAccountId: 4198, collection: 'debts', id: 'travelvisa', role: 'revolving-credit' },
  ]);
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4106, name: 'Travel Visa', type: 'credit', subtype: 'credit_card',
      balance: 800, limit: 1100, evidenceDate: '2026-08-18',
    }),
  ]), [{
    id: 88071, account_id: 4106, date: '2026-08-18', amount: 250,
    payee: 'Match', is_pending: true, status: 'unreviewed',
  }, {
    id: 88072, account_id: 4198, date: '2026-08-18', amount: 342.65,
    payee: 'Conflict', is_pending: true, status: 'unreviewed',
  }], completePendingCoverage());
  const { preview } = previewAt(data, payload, { accountMap: map, cutoverAsOf: '2026-08-18' });
  ok(preview.openingCutover.status === 'BLOCKED'
    && preview.openingCutover.cutoverWriteSupported === false,
    'conflicted pending cannot authorize an opening');
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', data);
  const before = hashFile(dest);
  const applied = runCli([
    '--fixture', writeJson(dir, 'payload.json', payload),
    '--map', writeJson(dir, 'map.json', map),
    '--data', dest,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve-opening', 'a'.repeat(64),
  ]);
  ok(applied.code !== 0, 'conflicted opening apply is refused');
  ok(hashFile(dest) === before, 'conflict refusal is byte-identical');
}

console.log('\n=== 10. stale posted evidence blocks unless owner statement cadence accepts it ===');
{
  const stale = cleanMatchPacket();
  stale.payload.accounts = matchingPostedAccounts(stale.data, '2026-08-16');
  const stalePreview = previewAt(stale.data, stale.payload, { accountMap: stale.map, cutoverAsOf: '2026-08-18' });
  ok(stalePreview.preview.openingCutover.cutoverWriteSupported === false,
    'stale exact-day MATCH cannot propose an opening');
  ok((stalePreview.preview.openingCutover.blockers || []).some(b => b.code === 'stale-posted-opening-evidence'),
    'stale posted evidence is an opening blocker');

  const data = makeData({
    debts: [
      { id: 'mortgage', balance: 500000, pending: 0, secured: true, interestTreatment: 'paid-in-payment', limit: null },
      revolving({ id: 'triangle', label: 'Triangle', balance: 13197, pending: 0, limit: 13500 }),
    ],
  });
  const map = makeMap([{ providerAccountId: 4110, collection: 'debts', id: 'triangle', role: 'revolving-credit' }]);
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4110, name: 'Triangle', type: 'credit', subtype: 'credit_card',
      balance: 13495.32, limit: 13500, evidenceDate: '2026-08-17',
    }),
  ]), [], completePendingCoverage());
  const { preview } = previewAt(data, payload, { accountMap: map, cutoverAsOf: '2026-08-18' });
  const triangle = preview.openingCutover.proposedOpening.posted.find(row => row.locator === 'debts:triangle');
  ok(preview.openingCutover.cutoverWriteSupported === true, 'Triangle statement cadence can support the opening');
  ok(triangle && triangle.evidenceDate === '2026-08-17'
    && triangle.freshnessBasis === C.FRESHNESS_STATEMENT_CADENCE
    && near(triangle.proposedValue, 13495.32),
    'cadence accepts 17 Aug evidence without rewriting the evidence date');
  const dir = tempDir();
  const { applied, after } = applyOpening(dir, data, payload, map, preview.openingCutover.openingApprovalId);
  ok(applied.code === 0, 'cadence-accepted Triangle posted value is written', applied.stderr.trim());
  ok(near(debtOf(after, 'triangle').balance, 13495.32), 'Triangle posted becomes 13495.32');
}

console.log('\n=== 11. current canonical opening mismatch invalidates an old approval ===');
{
  const pkt = postedChangePacket();
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  const stale = clone(pkt.data);
  stale.meta.asOf = '2026-08-17';
  stale.plan.opening.asOf = '2026-08-17';
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', stale);
  const before = hashFile(dest);
  const applied = runCli([
    '--fixture', writeJson(dir, 'payload.json', pkt.payload),
    '--map', writeJson(dir, 'map.json', pkt.map),
    '--data', dest,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve-opening', preview.openingCutover.openingApprovalId,
  ]);
  ok(applied.code !== 0, 'opening date drift refuses the old approval');
  ok(hashFile(dest) === before, 'opening-date mismatch leaves bytes identical');
}

console.log('\n=== 12. evidence recomputation drift invalidates an old approval ===');
{
  const pkt = postedChangePacket();
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  const drifted = clone(pkt.payload);
  drifted.accounts = drifted.accounts.map(row => (
    row.id === 4102 ? Object.assign({}, row, { balance: 175 }) : row
  ));
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', pkt.data);
  const before = hashFile(dest);
  const applied = runCli([
    '--fixture', writeJson(dir, 'payload.json', drifted),
    '--map', writeJson(dir, 'map.json', pkt.map),
    '--data', dest,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve-opening', preview.openingCutover.openingApprovalId,
  ]);
  ok(applied.code !== 0, 'evidence drift refuses the old openingApprovalId');
  ok(hashFile(dest) === before, 'evidence-drift refusal is byte-identical');
}

console.log('\n=== 13. wrong openingApprovalId writes nothing ===');
{
  const pkt = postedChangePacket();
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', pkt.data);
  const before = hashFile(dest);
  const wrong = runCli([
    '--fixture', writeJson(dir, 'payload.json', pkt.payload),
    '--map', writeJson(dir, 'map.json', pkt.map),
    '--data', dest,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve-opening', '0'.repeat(64),
  ]);
  ok(wrong.code !== 0, 'random openingApprovalId is refused');
  ok(hashFile(dest) === before, 'wrong openingApprovalId leaves bytes identical');
  ok(preview.openingCutover.openingApprovalId !== preview.previewId, 'opening id is not previewId');
}

console.log('\n=== 14. same-day represented event is recorded once and does not replay ===');
{
  const pkt = fullSyntheticPacket();
  const { preview } = previewAt(pkt.data, pkt.payload, {
    accountMap: pkt.map, identity: pkt.identity, cutoverAsOf: pkt.requested,
  });
  ok((preview.openingCutover.proposedOpening.representedEvents || []).some(e =>
    e.id === 'payroll' && e.date === pkt.requested),
    'proposed opening names the proven same-day payroll');
  const dir = tempDir();
  const { applied, after } = applyOpening(dir, pkt.data, pkt.payload, pkt.map,
    preview.openingCutover.openingApprovalId, { asOf: pkt.requested, identity: pkt.identity });
  ok(applied.code === 0, 'full synthetic opening writes', applied.stderr.trim());
  const events = after.plan.opening.representedEvents || [];
  ok(events.length === 1 && events[0].id === 'payroll' && events[0].date === pkt.requested,
    'representedEvents contains only the proven candidate-date payroll');
  const sim = Forecast.simulate(after.plan, pkt.requested, {});
  const replayed = (sim.events || []).filter(e => e.id === 'payroll' && e.date === pkt.requested);
  ok(replayed.length === 0, 'represented payroll does not replay through Forecast');
}

console.log('\n=== 15. unknown same-day representation blocks ===');
{
  const data = makeData({
    bills: [{
      id: 'rent', label: 'Rent', frequency: 'once', date: '2026-08-18',
      amount: 500, confidence: 'confirmed',
    }],
  });
  const map = makeMap([]);
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18'));
  const { preview } = previewAt(data, payload, { accountMap: map, cutoverAsOf: '2026-08-18' });
  ok(preview.openingCutover.status === 'BLOCKED'
    && preview.openingCutover.cutoverWriteSupported === false,
    'unknown same-day representation cannot propose an opening');
  ok((preview.openingCutover.blockers || []).some(b => b.code === 'same-day-event-representation-unknown'),
    'blocker is same-day-event-representation-unknown');
}

console.log('\n=== 16. historical represented-event candidate is not promoted ===');
{
  const data = makeData({
    income: [{
      id: 'payroll', label: 'Payroll', frequency: 'once', date: '2026-08-14',
      amount: 1000, confidence: 'confirmed',
    }],
  });
  const map = makeMap([]);
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18'), [{
    id: 88014, account_id: 4101, date: '2026-08-14', amount: -1000,
    payee: 'SEASPAN PAYROLL', is_pending: false, status: 'reviewed',
  }]);
  const { preview } = previewAt(data, payload, {
    accountMap: map, identity: payrollIdentity(), cutoverAsOf: '2026-08-18',
  });
  ok(!(preview.openingCutover.proposedOpening.representedEvents || []).some(e => e.id === 'payroll'),
    'historical payroll is not in the proposed opening representedEvents');
  ok((preview.openingCutover.warnings || []).some(w => w.code === 'historical-represented-candidate-not-promoted'),
    'historical candidate remains a warning, not a promotion');
}

console.log('\n=== 17–18. unresolved past outflows remain binding; settled items stay settled ===');
{
  const pkt = fullSyntheticPacket();
  const { preview } = previewAt(pkt.data, pkt.payload, {
    accountMap: pkt.map, identity: pkt.identity, cutoverAsOf: pkt.requested,
  });
  const dir = tempDir();
  const { after } = applyOpening(dir, pkt.data, pkt.payload, pkt.map,
    preview.openingCutover.openingApprovalId, { asOf: pkt.requested, identity: pkt.identity });
  const carried = Forecast.expandEvents(after.plan, pkt.requested, pkt.requested, {})
    .filter(e => e.id === 'owed');
  ok(carried.length === 1 && carried[0].date === '2026-08-16' && near(carried[0].amount, -100),
    'unresolved once outflow keeps its original scheduled date and amount');
  const sim = Forecast.simulate(after.plan, pkt.requested, {});
  const simOwed = (sim.events || []).filter(e => e.id === 'owed');
  ok(simOwed.length === 1 && simOwed[0].date === '2026-08-16',
    'Forecast still deducts the unresolved once outflow after the opening advances');
  const settled = Forecast.expandEvents(after.plan, pkt.requested, Forecast.addDays(pkt.requested, 30), {})
    .filter(e => e.id === 'settled-camp');
  ok(settled.length === 0, 'settled historical once item does not replay');
}

console.log('\n=== 19. representedEvents from the previous opening are not blindly copied ===');
{
  const pkt = fullSyntheticPacket();
  ok((pkt.data.plan.opening.representedEvents || []).some(e => e.id === 'old-payroll'),
    'fixture starts with a previous-opening represented event');
  const { preview } = previewAt(pkt.data, pkt.payload, {
    accountMap: pkt.map, identity: pkt.identity, cutoverAsOf: pkt.requested,
  });
  const dir = tempDir();
  const { after } = applyOpening(dir, pkt.data, pkt.payload, pkt.map,
    preview.openingCutover.openingApprovalId, { asOf: pkt.requested, identity: pkt.identity });
  ok(!(after.plan.opening.representedEvents || []).some(e => e.id === 'old-payroll'),
    'previous opening representedEvents are not copied forward');
}

console.log('\n=== 20–21. only approved fields change; as-of moves together ===');
{
  const pkt = fullSyntheticPacket();
  const { preview } = previewAt(pkt.data, pkt.payload, {
    accountMap: pkt.map, identity: pkt.identity, cutoverAsOf: pkt.requested,
  });
  const dir = tempDir();
  const { after } = applyOpening(dir, pkt.data, pkt.payload, pkt.map,
    preview.openingCutover.openingApprovalId, { asOf: pkt.requested, identity: pkt.identity });
  ok(after.meta.asOf === pkt.requested && after.plan.opening.asOf === pkt.requested,
    'meta.asOf and plan.opening.asOf moved together to 2026-08-18');
  ok(JSON.stringify(after.plan.nextDollar) === JSON.stringify(pkt.data.plan.nextDollar),
    'household nextDollar policy is unchanged');
  ok(near(cashOf(after, 'chequing-a').value, 1000) && near(cashOf(after, 'savings').value, 50),
    'unchanged cash MATCH facts stay at their approved observed values');
  ok(near(debtOf(after, 'mortgage').balance, 500000), 'mortgage MATCH is unchanged');
  ok(near(debtOf(after, 'travelvisa').limit, 1100) && near(debtOf(after, 'cashback').limit, 5000),
    'no limit/available-credit value became cash or moved');
}

console.log('\n=== 22. failure leaves target bytes identical ===');
{
  const pkt = postedChangePacket();
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', pkt.data);
  const before = hashFile(dest);
  const both = runCli([
    '--fixture', writeJson(dir, 'payload.json', pkt.payload),
    '--map', writeJson(dir, 'map.json', pkt.map),
    '--data', dest,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve', preview.previewId,
    '--approve-opening', preview.openingCutover.openingApprovalId,
  ]);
  ok(both.code !== 0, 'combined posted+opening approval is refused');
  ok(hashFile(dest) === before, 'combined-approval refusal is byte-identical');
  const noApply = runCli([
    '--fixture', writeJson(dir, 'payload2.json', pkt.payload),
    '--map', writeJson(dir, 'map2.json', pkt.map),
    '--data', dest,
    '--cutover-as-of', '2026-08-18',
  ]);
  ok(noApply.code === 0, 'preview-only opening CLI still exits 0');
  ok(hashFile(dest) === before, 'preview-only cutover writes nothing');
}

console.log('\n=== 23–24. successful opening is Forecast-consumable; live data.json untouched ===');
{
  const independentCash = 1000 + 190;
  const independentUsed = Math.round((800 + 342.65) * 100) / 100;
  ok(near(independentCash, 1190), 'independent chequing-only cash is 1190');
  ok(near(independentUsed, 1142.65), 'independent Travel Visa used is 800 + 342.65');
  const pkt = fullSyntheticPacket();
  const { preview } = previewAt(pkt.data, pkt.payload, {
    accountMap: pkt.map, identity: pkt.identity, cutoverAsOf: pkt.requested,
  });
  const fingerprint = C.openingFingerprint(preview.openingCutover, fixtureBalanceMapFor(pkt.data));
  ok(fingerprint.schema === C.OPENING_CUTOVER_SCHEMA, 'fingerprint schema is atlas-opening-cutover-approval/v1');
  ok(fingerprint.posted.some(row => row.locator === 'cash:chequing-a' && near(row.observedValue, 1000)),
    'fingerprint binds MATCH cash, not only CHANGE fields');
  ok(fingerprint.pending.some(row => row.locator === 'debts:travelvisa#pending')
    && fingerprint.pending.some(row => row.locator === 'debts:cashback#pending'),
    'fingerprint binds every participating pending state');
  ok(fingerprint.representedEvents.some(e => e.id === 'payroll'),
    'fingerprint binds candidate-date represented events');
  ok(fingerprint.routing.mappings.some(row => row.locator === 'cash:chequing-a'
    && row.accountLabel === 'Chequing A' && row.observationId === 'pos-chequing-a'),
    'fingerprint binds canonical locator to Household label and observation id');
  ok(fingerprint.routing.excluded.includes('Wise account 1 (USD spending)'),
    'fingerprint binds exclusions that affect the opening');
  const dir = tempDir();
  const { dest, applied, after } = applyOpening(dir, pkt.data, pkt.payload, pkt.map,
    preview.openingCutover.openingApprovalId, { asOf: pkt.requested, identity: pkt.identity });
  ok(applied.code === 0, 'full synthetic opening apply succeeds', applied.stderr.trim());
  const printed = JSON.parse(applied.stdout);
  ok(printed.writesOpening === true && printed.snapshotWritten === true
    && printed.snapshotRequired === false
    && printed.snapshotFollows === C.SNAPSHOT_COMMAND && printed.snapshotAsOf === pkt.requested,
    'apply result records the snapshot as part of the opening using incumbent snapshot semantics');
  ok(near(Forecast.startingCashAmount(after.plan), independentCash),
    'Forecast cash independently equals 1190 after the opening');
  const rec = Forecast.recommend(after.plan, pkt.requested, {});
  ok(rec && rec.weekly != null, 'Forecast.recommend consumes the new opening');
  const projected = Forecast.projectDebts(after.plan, after.debts, pkt.requested, {});
  ok(projected && Array.isArray(projected.debts || projected.rows || [projected]),
    'Forecast.projectDebts consumes the new opening');
  const used = Forecast.utilisation(after.debts, null, after.plan);
  const travel = used.rows.find(r => r.id === 'travelvisa');
  const cashback = used.rows.find(r => r.id === 'cashback');
  ok(travel && near(travel.pending, 342.65) && near(travel.used, independentUsed),
    'debt utilisation consumes Travel Visa pending 342.65');
  ok(cashback && cashback.pendingUnknown !== true && near(cashback.pending, 0) && near(cashback.used, 4000),
    'debt utilisation consumes proven Cash Back pending 0');
  const copy = clone(after);
  copy.plan.bills.push({
    id: 'same-day-unrep',
    label: 'Unrepresented same-day outflow',
    frequency: 'once',
    date: pkt.requested,
    amount: 25,
    confidence: 'confirmed',
  });
  const unrep = Forecast.simulate(copy.plan, pkt.requested, {});
  ok((unrep.events || []).some(e => e.id === 'same-day-unrep' && near(e.amount, -25)),
    'same-day unrepresented outflow still counts through Forecast');
  ok(hashFile(LIVE_DATA) === liveHash, 'live data.json remains byte-identical');
  ok(dest !== LIVE_DATA, 'synthetic apply never targeted live data.json');
}

console.log('\n=== qualified minimum receipt survives synthetic canonical installation ===');
{
  const dir = tempDir(), pkt = cleanMatchPacket();
  pkt.data.plan.obligations = [{ id: 'invented-minimum', label: 'Invented issuer minimum', debtId: 'mortgage',
    effect: 'payment', frequency: 'once', date: '2026-08-19', amount: 12.34, payingAccount: 'chequing-a',
    confidence: 'confirmed', sentPayments: [{ scheduledDate: '2026-08-19', confirmed: true, intent: 'minimum',
      debitId: 'invented-sent-reference', postedOn: '2026-08-16', amount: 12.34, currency: 'cad',
      fundingAccountId: 'chequing-a', pending: false, cashIncludedAsOf: '2026-08-16' }] }];
  const proof = { id: 'invented-minimum', date: '2026-08-19', effectiveAsOf: '2026-08-16' };
  pkt.data.plan.opening.representedEvents = [proof];
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  ok(preview.openingCutover.cutoverWriteSupported === true, 'synthetic minimum opening is supported');
  const applied = applyOpening(dir, pkt.data, pkt.payload, pkt.map, preview.openingCutover.openingApprovalId);
  ok(applied.applied.code === 0, 'approved synthetic opening installs', applied.applied.stderr);
  ok(JSON.stringify(applied.after.plan.opening.representedEvents) === JSON.stringify([proof]),
    'installed data retains original occurrence and effective qualifier');
  ok(Forecast.cardMinimumState(applied.after.plan, '2026-08-18').payments[0].issuerMinimumStatus === 'satisfied',
    'installed opening keeps independently confirmed issuer knowledge');
  ok(Forecast.cardMinimumState(applied.after.plan, '2026-08-16').payments[0].issuerMinimumStatus === 'satisfied',
    'earliest confirmed date retains its historical meaning');
  ok(hashFile(LIVE_DATA) === liveHash, 'only temporary synthetic files were installed');
}

console.log('\n=== live household figures were not cut over ===');
{
  ok(liveData.meta.asOf === liveData.plan.opening.asOf,
    'this suite never desynchronized live meta.asOf from plan.opening.asOf');
  ok(hashFile(LIVE_DATA) === liveHash, 'live data.json hash is unchanged after the suite');
}

console.log('\n' + (failures ? `${failures} failure(s)` : 'All B81 opening-cutover writer checks passed'));
if (hashFile(LIVE_DATA) !== liveHash) {
  console.log('LIVE data.json changed — failing closed');
  process.exit(1);
}
process.exit(failures ? 1 : 0);
