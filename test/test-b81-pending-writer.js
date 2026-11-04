'use strict';
/* B81 bounded owner-approved pending writer.
 *
 * Proves candidate-date pending transitions can be written only through a
 * distinct cutover approval. Does not apply live Aug. 18 household values.
 * previewId cannot authorize pending. Opening as-of is not advanced.
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

const liveHash = hashFile(LIVE_DATA);
const liveData = JSON.parse(execFileSync('git', ['show', '28d08a12:data.json'], { encoding: 'utf8' }));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pending-writer-'));
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
      startingCash: {
        breakdown: [
          { id: 'chequing-a', value: 1000 },
          { id: 'chequing-b', value: 200 },
          { id: 'savings', value: 50 },
        ],
      },
      opening: { asOf, representedEvents: [] },
      nextDollar: { target: 'cashback', provenance: 'derived' },
      income: [],
      obligations: [],
      bills: [],
      commitments: [],
    },
    debts: [
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
  if (extra && extra.debts) data.debts = extra.debts;
  if (extra && extra.opening) data.plan.opening = extra.opening;
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
  return {
    id: spec.id,
    name: spec.name || String(spec.id),
    type: spec.type || 'cash',
    subtype: spec.subtype,
    balance: spec.balance,
    currency: 'cad',
    credit_limit: spec.limit,
    updated_at: `${spec.evidenceDate}T17:55:00.000Z`,
    balance_last_update: `${spec.evidenceDate}T17:55:00.000Z`,
  };
}

function matchingPostedAccounts(data, evidenceDate) {
  return [
    accountRow({
      id: 4101, name: 'Chequing A', type: 'cash', subtype: 'checking',
      balance: data.plan.startingCash.breakdown.find(r => r.id === 'chequing-a').value,
      evidenceDate,
    }),
    accountRow({
      id: 4102, name: 'Chequing B', type: 'cash', subtype: 'checking',
      balance: data.plan.startingCash.breakdown.find(r => r.id === 'chequing-b').value,
      evidenceDate,
    }),
    accountRow({
      id: 4103, name: 'Savings', type: 'cash', subtype: 'savings',
      balance: data.plan.startingCash.breakdown.find(r => r.id === 'savings').value,
      evidenceDate,
    }),
    accountRow({
      id: 4108, name: 'Mortgage', type: 'loan', subtype: 'mortgage',
      balance: data.debts.find(r => r.id === 'mortgage').balance,
      evidenceDate,
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
    source: 'Synthetic pending-writer fixture. Not a live institution pull. Fixture IDs 4101–4199 are not live provider IDs.',
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
    identity: { rules: [], billPaymentPayees: [] },
    fetchedAt: payload.fetchedAt,
  }, extra.cutoverAsOf ? { cutoverAsOf: extra.cutoverAsOf } : undefined);
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

function travelPacket() {
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

function triangleZeroPacket() {
  const data = makeData({
    debts: [
      { id: 'mortgage', balance: 500000, pending: 0, secured: true, interestTreatment: 'paid-in-payment', limit: null },
      revolving({ id: 'triangle', label: 'Triangle', balance: 13197, pending: 15.62, limit: 13500 }),
    ],
  });
  const map = makeMap([{ providerAccountId: 4110, collection: 'debts', id: 'triangle', role: 'revolving-credit' }]);
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4110, name: 'Triangle', type: 'credit', subtype: 'credit_card',
      balance: 13197, limit: 13500, evidenceDate: '2026-08-18',
    }),
  ]), [], completePendingCoverage());
  return { data, map, payload };
}

function cashbackUnknownPacket(coverage) {
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
  ]), [], coverage);
  return { data, map, payload };
}

console.log('=== 1. ordinary posted preview/apply contract is unchanged ===');
{
  const identityPath = path.join(ROOT, 'docs', 'connectivity', 'transaction-identity.json');
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
  const first = C.previewFrom({
    provider: 'lunchmoney',
    payload: JSON.parse(fs.readFileSync(B81_FIXTURE, 'utf8')),
    accountMap: JSON.parse(fs.readFileSync(B81_MAP, 'utf8')),
    data: liveData,
    identity,
    fetchedAt: JSON.parse(fs.readFileSync(B81_FIXTURE, 'utf8')).fetchedAt,
  });
  ok(!first.preview.proposed.some(row => /pending/.test(String(row.locator || '')) || row.field === 'pending'),
    'ordinary posted preview still has no pending locators');
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', liveData);
  const applied = runCli([
    '--fixture', B81_FIXTURE, '--map', B81_MAP, '--data', dest,
    '--apply', '--approve', first.preview.previewId,
  ]);
  ok(applied.code === 0, 'ordinary --apply --approve still writes posted fields', applied.stderr.trim());
  const after = JSON.parse(fs.readFileSync(dest, 'utf8'));
  ok(near(after.plan.startingCash.breakdown.find(r => r.id === 'chequing-b').value, 922.05),
    'approved posted write still applies Chequing B 932.05 → 922.05');
  const cashback = after.debts.find(d => d.id === 'cashback');
  ok(cashback && cashback.pendingUnknown === true && cashback.pending == null,
    'ordinary posted apply does not write Cash Back pending');
  ok(after.meta.asOf === liveData.meta.asOf && after.plan.opening.asOf === liveData.plan.opening.asOf,
    'ordinary posted apply does not move as-of');
  ok(hashFile(LIVE_DATA) === liveHash, 'live data.json is unchanged by posted apply');
}

console.log('\n=== 2. posted previewId cannot authorize pending ===');
{
  const pkt = travelPacket();
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', pkt.data);
  const before = hashFile(dest);
  const piggyback = runCli([
    '--fixture', writeJson(dir, 'payload.json', pkt.payload),
    '--map', writeJson(dir, 'map.json', pkt.map),
    '--data', dest,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve', preview.previewId,
  ]);
  ok(piggyback.code !== 0, 'cutover-as-of plus posted previewId is refused');
  ok(/previewId|approve/i.test(piggyback.stderr), 'refusal names the posted approval boundary',
    piggyback.stderr.trim());
  ok(hashFile(dest) === before, 'piggyback refusal leaves the target byte-identical');
  const asPosted = runCli([
    '--fixture', writeJson(dir, 'payload.json', pkt.payload),
    '--map', writeJson(dir, 'map.json', pkt.map),
    '--data', dest,
    '--apply', '--approve-cutover', preview.previewId,
  ]);
  ok(asPosted.code !== 0, '--approve-cutover without --cutover-as-of is refused');
  const both = runCli([
    '--fixture', writeJson(dir, 'payload.json', pkt.payload),
    '--map', writeJson(dir, 'map.json', pkt.map),
    '--data', dest,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve', preview.previewId,
    '--approve-cutover', preview.openingCutover.cutoverApprovalId,
  ]);
  ok(both.code !== 0, 'posted and cutover approvals cannot be combined');
  ok(hashFile(dest) === before, 'combined-approval refusal writes nothing');
}

console.log('\n=== 3. known 250 -> proven 342.65 is a bounded cutover proposal ===');
{
  const independentDelta = Math.round((342.65 - 250) * 100) / 100;
  ok(near(independentDelta, 92.65), 'independent 342.65 − 250 = 92.65');
  const pkt = travelPacket();
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  const hit = (preview.openingCutover.pendingTransitions || []).find(row => row.locator === 'debts:travelvisa#pending');
  ok(hit && near(hit.currentValue, 250) && near(hit.proposedValue, 342.65),
    'proposal is 250 → 342.65');
  ok(hit.currentUnknown !== true && hit.evidenceDate === '2026-08-18',
    'proposal is a known numeric candidate-date transition');
  ok(!preview.proposed.some(row => row.locator === 'debts:travelvisa#pending'),
    '250 → 342.65 is absent from the posted proposed set');
  ok(preview.openingCutover.cutoverApprovalId
    && preview.openingCutover.cutoverApprovalId !== preview.previewId,
    'cutoverApprovalId differs from previewId');
}

console.log('\n=== 4. known 15.62 -> proven 0 only when zero is actually proven ===');
{
  const proven = triangleZeroPacket();
  const provenPreview = previewAt(proven.data, proven.payload, {
    accountMap: proven.map, cutoverAsOf: '2026-08-18',
  });
  const provenHit = (provenPreview.preview.openingCutover.pendingTransitions || [])
    .find(row => row.locator === 'debts:triangle#pending');
  ok(provenHit && near(provenHit.currentValue, 15.62) && near(provenHit.proposedValue, 0)
    && provenHit.proof === 'is_pending-unbounded',
    'complete census proposes 15.62 → proven 0');

  const unprovenPayload = makePayload('2026-08-18', proven.payload.accounts, []);
  const unprovenPreview = previewAt(proven.data, unprovenPayload, {
    accountMap: proven.map, cutoverAsOf: '2026-08-18',
  });
  ok(!(unprovenPreview.preview.openingCutover.pendingTransitions || [])
    .some(row => row.locator === 'debts:triangle#pending'),
    'incomplete coverage does not propose 15.62 → 0');
  ok((unprovenPreview.preview.openingCutover.blockers || [])
    .some(b => b.code === 'pending-freshness-unproven' && b.locator === 'debts:triangle#pending'),
    'unproven zero remains pending-freshness-unproven');
}

console.log('\n=== 5. UNKNOWN -> proven 0 writes pending=0 and clears UNKNOWN ===');
{
  const independentPostedRoom = Math.round((5000 - 4000) * 100) / 100;
  ok(near(independentPostedRoom, 1000), 'independent posted room after pending 0 is $1,000');
  const pkt = cashbackUnknownPacket(completePendingCoverage());
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  const hit = (preview.openingCutover.pendingTransitions || []).find(row => row.locator === 'debts:cashback#pending');
  ok(hit && hit.currentUnknown === true && hit.currentValue == null && near(hit.proposedValue, 0),
    'proposal is UNKNOWN → proven 0');
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', pkt.data);
  const before = hashFile(dest);
  const applied = runCli([
    '--fixture', writeJson(dir, 'payload.json', pkt.payload),
    '--map', writeJson(dir, 'map.json', pkt.map),
    '--data', dest,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve-cutover', preview.openingCutover.cutoverApprovalId,
  ]);
  ok(applied.code === 0, 'exact cutover approval writes UNKNOWN → 0', applied.stderr.trim());
  const after = JSON.parse(fs.readFileSync(dest, 'utf8'));
  const cashback = after.debts.find(d => d.id === 'cashback');
  ok(cashback && cashback.pendingUnknown === false && near(cashback.pending, 0),
    'canonical pending is 0 and UNKNOWN is cleared');
  ok(after.meta.asOf === '2026-08-16' && after.plan.opening.asOf === '2026-08-16',
    'UNKNOWN → 0 does not move opening as-of');
  ok(near(after.plan.startingCash.breakdown.find(r => r.id === 'chequing-a').value, 1000),
    'cash is unchanged by the pending write');
  ok(near(cashback.balance, 4000) && near(cashback.limit, 5000),
    'posted balance and limit are unchanged');
  const used = Forecast.utilisation(after.debts, null, after.plan);
  const row = used.rows.find(r => r.id === 'cashback');
  ok(row && near(row.pending, 0) && near(row.used, 4000) && near(row.available, independentPostedRoom),
    'Forecast consumes written pending 0: used 4000, available 1000');
  ok(hashFile(dest) !== before, 'successful pending write changes the temp file');
  ok(hashFile(LIVE_DATA) === liveHash, 'live data.json is unchanged by UNKNOWN → 0');
}

console.log('\n=== 6. incomplete coverage never turns UNKNOWN into zero ===');
{
  const pkt = cashbackUnknownPacket(undefined);
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  ok(!(preview.openingCutover.pendingTransitions || []).some(row => row.locator === 'debts:cashback#pending'),
    'bounded empty window does not propose UNKNOWN → 0');
  ok((preview.openingCutover.warnings || []).some(w => w.code === 'pending-remains-unknown'),
    'UNKNOWN remains UNKNOWN without complete coverage');
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', pkt.data);
  const before = hashFile(dest);
  const applied = runCli([
    '--fixture', writeJson(dir, 'payload.json', pkt.payload),
    '--map', writeJson(dir, 'map.json', pkt.map),
    '--data', dest,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve-cutover', 'f'.repeat(64),
  ]);
  ok(applied.code !== 0, 'no cutover proposal means no pending write');
  const after = JSON.parse(fs.readFileSync(dest, 'utf8'));
  const cashback = after.debts.find(d => d.id === 'cashback');
  ok(cashback && cashback.pendingUnknown === true && cashback.pending == null,
    'canonical UNKNOWN is untouched');
  ok(hashFile(dest) === before, 'incomplete-coverage refusal is byte-identical');
}

console.log('\n=== 7. conflicting candidate-date pending remains BLOCKED and unwritable ===');
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
  ok(preview.openingCutover.status === 'BLOCKED', 'conflicted pending still BLOCKED');
  ok((preview.openingCutover.blockers || []).some(b => b.code === 'pending-state-change-unresolved'
    && b.locator === 'debts:travelvisa#pending' && b.observedValue == null),
    'conflict does not choose 250 or 342.65');
  ok(!(preview.openingCutover.pendingTransitions || []).length,
    'conflict produces no pending proposal');
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', data);
  const before = hashFile(dest);
  const applied = runCli([
    '--fixture', writeJson(dir, 'payload.json', payload),
    '--map', writeJson(dir, 'map.json', map),
    '--data', dest,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve-cutover', 'a'.repeat(64),
  ]);
  ok(applied.code !== 0, 'conflicted pending cannot be approved');
  ok(near(JSON.parse(fs.readFileSync(dest, 'utf8')).debts.find(d => d.id === 'travelvisa').pending, 250),
    'canonical 250 is unchanged');
  ok(hashFile(dest) === before, 'conflict refusal is byte-identical');
}

console.log('\n=== 8. wrong cutover approval ID writes nothing ===');
{
  const pkt = travelPacket();
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', pkt.data);
  const before = hashFile(dest);
  const wrong = runCli([
    '--fixture', writeJson(dir, 'payload.json', pkt.payload),
    '--map', writeJson(dir, 'map.json', pkt.map),
    '--data', dest,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve-cutover', preview.previewId,
  ]);
  ok(wrong.code !== 0, 'using posted previewId as cutover approval is refused');
  const alsoWrong = runCli([
    '--fixture', writeJson(dir, 'payload.json', pkt.payload),
    '--map', writeJson(dir, 'map.json', pkt.map),
    '--data', dest,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve-cutover', '0'.repeat(64),
  ]);
  ok(alsoWrong.code !== 0, 'a random cutover approval ID is refused');
  ok(hashFile(dest) === before, 'wrong approval leaves the target byte-identical');
}

console.log('\n=== 9. recomputation drift invalidates approval ===');
{
  const pkt = travelPacket();
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  const drifted = clone(pkt.payload);
  drifted.transactions = [{
    id: 88099,
    account_id: 4106,
    date: '2026-08-18',
    amount: 400.00,
    payee: 'Later Pending',
    is_pending: true,
    status: 'unreviewed',
  }];
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', pkt.data);
  const before = hashFile(dest);
  const applied = runCli([
    '--fixture', writeJson(dir, 'payload.json', drifted),
    '--map', writeJson(dir, 'map.json', pkt.map),
    '--data', dest,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve-cutover', preview.openingCutover.cutoverApprovalId,
  ]);
  ok(applied.code !== 0, 'stale evidence recomputation refuses the old cutover id');
  ok(hashFile(dest) === before, 'drift refusal is byte-identical');
}

console.log('\n=== 10. stale canonical pending invalidates approval ===');
{
  const pkt = travelPacket();
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  const stale = clone(pkt.data);
  stale.debts.find(d => d.id === 'travelvisa').pending = 260;
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', stale);
  const before = hashFile(dest);
  const applied = runCli([
    '--fixture', writeJson(dir, 'payload.json', pkt.payload),
    '--map', writeJson(dir, 'map.json', pkt.map),
    '--data', dest,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve-cutover', preview.openingCutover.cutoverApprovalId,
  ]);
  ok(applied.code !== 0, 'canonical pending 260 vs preview 250 is refused');
  ok(near(JSON.parse(fs.readFileSync(dest, 'utf8')).debts.find(d => d.id === 'travelvisa').pending, 260),
    'stale canonical pending is not overwritten');
  ok(hashFile(dest) === before, 'stale-canonical refusal is byte-identical');
}

console.log('\n=== 11–15. only approved pending locators change; Forecast consumes; live bytes hold ===');
{
  const independentUsed = Math.round((800 + 342.65) * 100) / 100;
  ok(near(independentUsed, 1142.65), 'independent Travel Visa used is posted 800 + pending 342.65');
  const pkt = travelPacket();
  pkt.data.debts.push(revolving({
    id: 'tdcc', label: 'TD Personal', balance: 1700, pending: 40, limit: 2000,
  }));
  pkt.map.mappings.push({
    providerAccountId: '4104',
    canonical: { collection: 'debts', id: 'tdcc' },
    atlasRole: 'revolving-credit',
  });
  pkt.payload.accounts.push(accountRow({
    id: 4104, name: 'Personal Card', type: 'credit', subtype: 'credit_card',
    balance: 1700, limit: 2000, evidenceDate: '2026-08-18',
  }));
  pkt.payload.transactions.push({
    id: 88040,
    account_id: 4104,
    date: '2026-08-18',
    amount: 40,
    payee: 'TD Pending Match',
    is_pending: true,
    status: 'unreviewed',
  });
  const { preview } = previewAt(pkt.data, pkt.payload, { accountMap: pkt.map, cutoverAsOf: '2026-08-18' });
  ok((preview.openingCutover.pendingTransitions || []).length === 1
    && preview.openingCutover.pendingTransitions[0].locator === 'debts:travelvisa#pending',
    'only Travel Visa pending is in the approved set; TD Personal 40 MATCH is excluded');
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', pkt.data);
  const applied = runCli([
    '--fixture', writeJson(dir, 'payload.json', pkt.payload),
    '--map', writeJson(dir, 'map.json', pkt.map),
    '--data', dest,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve-cutover', preview.openingCutover.cutoverApprovalId,
  ]);
  ok(applied.code === 0, 'exact cutover approval writes Travel Visa pending', applied.stderr.trim());
  const after = JSON.parse(fs.readFileSync(dest, 'utf8'));
  const tv = after.debts.find(d => d.id === 'travelvisa');
  const tdcc = after.debts.find(d => d.id === 'tdcc');
  ok(near(tv.pending, 342.65) && tv.pendingUnknown !== true, 'approved Travel Visa pending is 342.65');
  ok(near(tdcc.pending, 40), 'unapproved TD Personal pending 40 is unchanged');
  ok(near(tv.balance, 800) && near(tdcc.balance, 1700), 'posted card balances are unchanged');
  ok(near(after.plan.startingCash.breakdown.find(r => r.id === 'chequing-b').value, 200),
    'chequing is unchanged');
  ok(JSON.stringify(after.plan.nextDollar) === JSON.stringify(pkt.data.plan.nextDollar),
    'plan policy is unchanged');
  ok(JSON.stringify(after.plan.opening.representedEvents) === JSON.stringify([]),
    'representedEvents stay empty');
  ok(after.meta.asOf === '2026-08-16' && after.plan.opening.asOf === '2026-08-16',
    'opening as-of is unchanged');
  const used = Forecast.utilisation(after.debts, null, after.plan);
  const tvRow = used.rows.find(r => r.id === 'travelvisa');
  ok(tvRow && near(tvRow.pending, 342.65) && near(tvRow.used, independentUsed),
    'Forecast uses written pending: 800 + 342.65 = 1142.65');
  ok(hashFile(LIVE_DATA) === liveHash, 'live data.json is byte-identical after the pending-writer suite');
}

console.log('\n' + (failures ? `${failures} failure(s)` : 'All bounded pending-writer checks passed'));
if (hashFile(LIVE_DATA) !== liveHash) {
  console.log('LIVE data.json changed — failing closed');
  process.exit(1);
}
process.exit(failures ? 1 : 0);
