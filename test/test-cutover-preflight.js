'use strict';
/* B81 opening-cutover preflight — read-only evidence packet.
 *
 * Proves Atlas can fail closed on whether a proposed opening date is
 * coherent, without performing that cutover. Synthetic fixtures only.
 * Does not apply live balances, move as-of, write representedEvents, or
 * add a pending writer.
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
const B81_FIXTURE = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'lunchmoney-b81-refresh.json');
const B81_MAP = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'b81-account-map.json');
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

const liveHash = hashFile(LIVE_DATA);
const liveData = JSON.parse(execFileSync('git', ['show', '28d08a12:data.json'], { encoding: 'utf8' }));
const b81Payload = JSON.parse(fs.readFileSync(B81_FIXTURE, 'utf8'));
const b81Map = JSON.parse(fs.readFileSync(B81_MAP, 'utf8'));
const defaultIdentity = JSON.parse(fs.readFileSync(IDENTITY, 'utf8'));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cutover-preflight-'));
}

function writeJson(dir, name, value) {
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
  if (!extra) return data;
  if (extra.meta) Object.assign(data.meta, extra.meta);
  if (extra.plan) Object.assign(data.plan, extra.plan);
  if (extra.startingCash) data.plan.startingCash = extra.startingCash;
  if (extra.opening) data.plan.opening = extra.opening;
  if (extra.income) data.plan.income = extra.income;
  if (extra.bills) data.plan.bills = extra.bills;
  if (extra.obligations) data.plan.obligations = extra.obligations;
  if (extra.debts) data.debts = extra.debts;
  if (extra.cash) {
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
    mappings: entries.map(entry => ({
      providerAccountId: String(entry.providerAccountId),
      canonical: { collection: entry.collection, id: entry.id },
      atlasRole: entry.role,
    })),
  };
}

const BASE_MAP = makeMap([
  { providerAccountId: 4101, collection: 'cash', id: 'chequing-a', role: 'household-cash' },
  { providerAccountId: 4102, collection: 'cash', id: 'chequing-b', role: 'household-cash' },
  { providerAccountId: 4103, collection: 'cash', id: 'savings', role: 'household-cash' },
  { providerAccountId: 4108, collection: 'debts', id: 'mortgage', role: 'mortgage' },
]);

function extendMap(extra) {
  return {
    schema: BASE_MAP.schema,
    provider: BASE_MAP.provider,
    scope: BASE_MAP.scope,
    mappings: BASE_MAP.mappings.concat(extra.map(entry => ({
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
    balance: spec.balance,
    currency: 'cad',
    updated_at: spec.updatedAt || `${spec.evidenceDate}T17:55:00.000Z`,
    balance_last_update: spec.updatedAt || `${spec.evidenceDate}T17:55:00.000Z`,
  };
  if (spec.limit != null) row.credit_limit = spec.limit;
  if (spec.available != null) row.available_balance = spec.available;
  if (spec.subtype) row.subtype = spec.subtype;
  if (spec.balanceAsOf) row.balance_as_of = spec.balanceAsOf;
  if (spec.dateLastFetched) row.date_last_fetched = spec.dateLastFetched;
  return row;
}

function revolvingDebt(spec) {
  return {
    id: spec.id,
    balance: spec.balance,
    pending: spec.pending == null ? 0 : spec.pending,
    pendingUnknown: spec.pendingUnknown === true,
    secured: false,
    limit: spec.limit,
  };
}

function makePayload(fetchedAsOf, accounts, transactions, extra) {
  return Object.assign({
    provider: 'lunchmoney',
    fetchedAt: `${fetchedAsOf}T18:00:00.000Z`,
    source: 'Synthetic opening-cutover preflight fixture. Not a live institution pull. Fixture IDs 4101–4199 are not live provider IDs.',
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
      balance: data.debts.find(d => d.id === 'mortgage').balance,
      evidenceDate,
    }),
  ];
}

function previewAt(data, payload, extra) {
  return C.previewFrom({
    provider: 'lunchmoney',
    payload,
    accountMap: (extra && extra.accountMap) || BASE_MAP,
    data,
    identity: (extra && extra.identity) || { rules: [], billPaymentPayees: [] },
    fetchedAt: payload.fetchedAt,
  }, extra && extra.cutoverAsOf ? { cutoverAsOf: extra.cutoverAsOf } : undefined);
}

function codes(list) {
  return (list || []).map(item => item.code);
}

function freshness(cutover, locator) {
  return (cutover.accountFreshness || []).find(row => row.locator === locator) || null;
}

console.log('=== CASE 1 — existing B81 behavior unchanged without --cutover-as-of ===');
{
  const first = C.previewFrom({
    provider: 'lunchmoney',
    payload: b81Payload,
    accountMap: b81Map,
    data: liveData,
    identity: defaultIdentity,
    fetchedAt: b81Payload.fetchedAt,
  });
  const second = C.previewFrom({
    provider: 'lunchmoney',
    payload: b81Payload,
    accountMap: b81Map,
    data: liveData,
    identity: defaultIdentity,
    fetchedAt: b81Payload.fetchedAt,
  }, { cutoverAsOf: '2026-08-18' });
  ok(first.preview.writesCanonicalState === false, 'preview remains non-writing');
  ok(!Object.prototype.hasOwnProperty.call(first.preview, 'openingCutover'),
    'ordinary preview has no openingCutover section');
  ok(first.preview.previewId === second.preview.previewId,
    'cutover diagnostics do not change previewId');
  ok(JSON.stringify(first.preview.proposed) === JSON.stringify(second.preview.proposed),
    'proposed posted set is unchanged by cutover diagnostics');
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', liveData);
  const before = hashFile(dest);
  const applied = runCli([
    '--fixture', B81_FIXTURE, '--map', B81_MAP, '--data', dest,
    '--apply', '--approve', first.preview.previewId,
  ]);
  ok(applied.code === 0, 'existing --apply --approve remains the posted-field writer',
    applied.stderr.trim());
  const after = JSON.parse(fs.readFileSync(dest, 'utf8'));
  ok(after.meta.asOf === liveData.meta.asOf, 'posted refresh does not move meta.asOf');
  ok(after.plan.opening.asOf === liveData.plan.opening.asOf,
    'posted refresh does not move plan.opening.asOf');
  ok(near(after.plan.startingCash.breakdown.find(r => r.id === 'chequing-b').value, 922.05),
    'approved posted write still applies Chequing B');
  ok(hashFile(dest) !== before, 'approved apply did write the temp copy');
  ok(hashFile(LIVE_DATA) === liveHash, 'live data.json is unchanged');
}

console.log('\n=== CASE 2 — cutover preflight cannot write ===');
{
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', liveData);
  const before = hashFile(dest);
  const refused = runCli([
    '--fixture', B81_FIXTURE, '--map', B81_MAP, '--data', dest,
    '--cutover-as-of', '2026-08-18', '--apply', '--approve', '0'.repeat(64),
  ]);
  ok(refused.code !== 0, '--cutover-as-of combined with --apply is refused');
  ok(/read-only|refused/i.test(refused.stderr), 'the error names the read-only refusal',
    refused.stderr.trim());
  ok(hashFile(dest) === before, 'refused cutover apply leaves temp data.json byte-identical');
  const after = JSON.parse(fs.readFileSync(dest, 'utf8'));
  ok(after.meta.asOf === liveData.meta.asOf, 'meta.asOf is unchanged');
  ok(after.plan.opening.asOf === liveData.plan.opening.asOf, 'plan.opening.asOf is unchanged');
  const previewOnly = runCli([
    '--fixture', B81_FIXTURE, '--map', B81_MAP, '--data', dest,
    '--cutover-as-of', '2026-08-18',
  ]);
  ok(previewOnly.code === 0, 'cutover preflight CLI exits 0');
  const printed = JSON.parse(previewOnly.stdout);
  ok(printed.openingCutover && printed.openingCutover.writesOpening === false,
    'preflight declares writesOpening false');
  ok(printed.openingCutover.cutoverWriteSupported === false,
    'preflight declares cutoverWriteSupported false');
  ok(printed.openingCutover.status !== 'READY_TO_WRITE',
    'preflight never says READY_TO_WRITE');
  ok(hashFile(dest) === before, 'preview cutover CLI does not write');
  ok(hashFile(LIVE_DATA) === liveHash, 'live data.json is unchanged by cutover CLI');
}

console.log('\n=== CASE 3 — MATCH is not freshness ===');
{
  const data = makeData({ asOf: '2026-08-16' });
  const payload = makePayload('2026-08-18', [
    ...matchingPostedAccounts(data, '2026-08-18').map(row => (
      row.id === 4108 ? Object.assign({}, row, { updated_at: '2026-08-16T17:55:00.000Z', balance_last_update: '2026-08-16T17:55:00.000Z' }) : row
    )),
  ]);
  // Independent expected freshness: evidence date 16th, requested 18th.
  const independentFresh = '2026-08-16' === '2026-08-18';
  const { preview } = previewAt(data, payload, { cutoverAsOf: '2026-08-18' });
  const row = freshness(preview.openingCutover, 'debts:mortgage');
  ok(row && near(row.canonicalValue, 500000) && near(row.observedValue, 500000),
    'mortgage MATCH values agree');
  ok(row && row.reconcileStatus === 'MATCH', 'reconcile status is MATCH');
  ok(row && row.evidenceDate === '2026-08-16', 'evidence date is the older observation');
  ok(row && row.freshForRequestedAsOf === independentFresh
    && row.freshForRequestedAsOf === false,
    'MATCH on 2026-08-16 is not fresh for 2026-08-18');
  ok(preview.openingCutover.status === 'BLOCKED', 'stale MATCH blocks the 18th opening');
  ok(codes(preview.openingCutover.blockers).includes('stale-posted-opening-evidence'),
    'blocker code is stale-posted-opening-evidence');
}

console.log('\n=== CASE 4 — fresh MATCH ===');
{
  const data = makeData({ asOf: '2026-08-16' });
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18'));
  const { preview } = previewAt(data, payload, { cutoverAsOf: '2026-08-18' });
  const row = freshness(preview.openingCutover, 'debts:mortgage');
  ok(row && row.reconcileStatus === 'MATCH', 'same value still MATCH');
  ok(row && row.evidenceDate === '2026-08-18', 'evidence date is exactly the requested date');
  ok(row && row.freshForRequestedAsOf === true, 'exact-date MATCH is freshForRequestedAsOf');
}

console.log('\n=== CASE 5 — posted CHANGE does not by itself block cutover ===');
{
  const data = makeData({ asOf: '2026-08-16', cash: { 'chequing-b': 200 } });
  const accounts = matchingPostedAccounts(data, '2026-08-18').map(row => (
    row.id === 4102 ? Object.assign({}, row, { balance: 190 }) : row
  ));
  const payload = makePayload('2026-08-18', accounts);
  const { preview } = previewAt(data, payload, { cutoverAsOf: '2026-08-18' });
  ok(preview.proposed.some(row => row.locator === 'cash:chequing-b' && near(row.proposedValue, 190)),
    'candidate-date posted CHANGE is shown as a proposed posted refresh');
  ok(preview.openingCutover.status === 'READY_FOR_OWNER_REVIEW',
    'a clean posted CHANGE does not make cutover impossible');
  ok(preview.openingCutover.writesOpening === false
    && preview.canonicalWriteAuthorized === false,
    'the proposed CHANGE is not a cutover authorization');
  ok(!codes(preview.openingCutover.blockers).includes('stale-posted-opening-evidence'),
    'fresh CHANGE is not reported as stale');
}

console.log('\n=== CASE 6 — pending CHANGE blocks and does not write ===');
{
  const data = makeData({
    asOf: '2026-08-16',
    debts: [
      {
        id: 'mortgage', balance: 500000, pending: 0, secured: true,
        interestTreatment: 'paid-in-payment', limit: null,
      },
      {
        id: 'travelvisa', balance: 800, pending: 250, pendingUnknown: false,
        secured: false, limit: 1100,
      },
    ],
  });
  const map = extendMap([{
    providerAccountId: 4106, collection: 'debts', id: 'travelvisa', role: 'revolving-credit',
  }]);
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
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', data);
  const before = hashFile(dest);
  const { preview } = previewAt(data, payload, { accountMap: map, cutoverAsOf: '2026-08-18' });
  ok(!codes(preview.openingCutover.blockers).includes('pending-state-change-unresolved'),
    'a trustworthy pending CHANGE is a cutover proposal, not a permanent blocker');
  const pendingHit = (preview.openingCutover.pendingTransitions || []).find(row => row.locator === 'debts:travelvisa#pending');
  ok(pendingHit && near(pendingHit.currentValue, 250) && near(pendingHit.proposedValue, 342.65),
    'cutover pending proposal names canonical 250 vs observed 342.65');
  ok(preview.openingCutover.cutoverApprovalId
    && preview.openingCutover.cutoverApprovalId !== preview.previewId,
    'cutover approval id is distinct from posted previewId');
  ok(!preview.proposed.some(row => /pending/.test(row.locator || '') || row.field === 'pending'),
    'no pending write is proposed on the ordinary posted preview');
  const applied = runCli([
    '--fixture', writeJson(dir, 'payload.json', payload),
    '--map', writeJson(dir, 'map.json', map),
    '--data', dest,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve', preview.previewId,
  ]);
  ok(applied.code !== 0, 'cutover plus apply remains refused during pending CHANGE');
  const after = JSON.parse(fs.readFileSync(dest, 'utf8'));
  ok(near(after.debts.find(d => d.id === 'travelvisa').pending, 250),
    'canonical pending is not written');
  ok(hashFile(dest) === before, 'pending CHANGE leaves data.json byte-identical');
}

console.log('\n=== CASE 6b — conflicted pending is not resolved by one matching observation ===');
{
  const data = makeData({
    asOf: '2026-08-16',
    debts: [
      {
        id: 'mortgage', balance: 500000, pending: 0, secured: true,
        interestTreatment: 'paid-in-payment', limit: null,
      },
      {
        id: 'travelvisa', balance: 800, pending: 250, pendingUnknown: false,
        secured: false, limit: 1100,
      },
    ],
  });
  const map = extendMap([
    {
      providerAccountId: 4106, collection: 'debts', id: 'travelvisa', role: 'revolving-credit',
    },
    {
      providerAccountId: 4198, collection: 'debts', id: 'travelvisa', role: 'revolving-credit',
    },
  ]);
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4106, name: 'Travel Visa', type: 'credit', subtype: 'credit_card',
      balance: 800, limit: 1100, evidenceDate: '2026-08-18',
    }),
  ]), [{
    id: 88071,
    account_id: 4106,
    date: '2026-08-18',
    amount: 250,
    payee: 'Merchant Pending Match',
    is_pending: true,
    status: 'unreviewed',
  }, {
    id: 88072,
    account_id: 4198,
    date: '2026-08-18',
    amount: 342.65,
    payee: 'Merchant Pending Conflict',
    is_pending: true,
    status: 'unreviewed',
  }]);
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', data);
  const before = hashFile(dest);
  const { report, preview } = previewAt(data, payload, { accountMap: map, cutoverAsOf: '2026-08-18' });
  const pendingRows = ((report.reconciliation && report.reconciliation.rows) || [])
    .filter(row => row && row.fact === 'pending' && row.cardId === 'travelvisa');
  const pendingValues = pendingRows.map(row => row.evidenceValue).sort((a, b) => a - b);
  ok(pendingRows.length === 2 && pendingRows.every(row => row.status === 'CONFLICT'),
    'reconciler marks both same-date pending observations CONFLICT');
  ok(near(pendingValues[0], 250) && near(pendingValues[1], 342.65),
    'independent observations are canonical 250 and disagreeing 342.65');
  ok(preview.openingCutover.status === 'BLOCKED',
    'conflicted pending blocks even when one observation equals canonical');
  ok(codes(preview.openingCutover.blockers).includes('pending-state-change-unresolved'),
    'blocker code is pending-state-change-unresolved');
  const pendingBlock = preview.openingCutover.blockers.find(b => b.code === 'pending-state-change-unresolved');
  ok(pendingBlock && near(pendingBlock.canonicalValue, 250) && pendingBlock.observedValue == null,
    'blocker does not choose one numeric pending observation');
  ok(!preview.proposed.some(row => /pending/.test(row.locator || '') || row.field === 'pending'),
    'no pending write is proposed');
  const applied = runCli([
    '--fixture', writeJson(dir, 'payload.json', payload),
    '--map', writeJson(dir, 'map.json', map),
    '--data', dest,
    '--cutover-as-of', '2026-08-18',
    '--apply', '--approve', preview.previewId,
  ]);
  ok(applied.code !== 0, 'cutover plus apply remains refused during pending CONFLICT');
  const after = JSON.parse(fs.readFileSync(dest, 'utf8'));
  ok(near(after.debts.find(d => d.id === 'travelvisa').pending, 250),
    'canonical pending is not written');
  ok(hashFile(dest) === before, 'pending CONFLICT leaves data.json byte-identical');
}

console.log('\n=== CASE 7 — pending UNKNOWN is preserved and is not zero ===');
{
  const data = makeData({
    asOf: '2026-08-16',
    debts: [
      {
        id: 'mortgage', balance: 500000, pending: 0, secured: true,
        interestTreatment: 'paid-in-payment', limit: null,
      },
      {
        id: 'cashback', balance: 4000, pending: null, pendingUnknown: true,
        secured: false, limit: 5000,
      },
    ],
  });
  const map = extendMap([{
    providerAccountId: 4105, collection: 'debts', id: 'cashback', role: 'revolving-credit',
  }]);
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4105, name: 'Cash Back', type: 'credit', subtype: 'credit_card',
      balance: 4000, limit: 5000, evidenceDate: '2026-08-18',
    }),
  ]));
  const { preview } = previewAt(data, payload, { accountMap: map, cutoverAsOf: '2026-08-18' });
  const blob = JSON.stringify(preview.openingCutover);
  ok(codes(preview.openingCutover.warnings).includes('pending-remains-unknown'),
    'UNKNOWN pending is a warning');
  ok(!/pending-remains-unknown[\s\S]{0,200}"observedValue": 0/.test(blob),
    'UNKNOWN pending is not emitted as 0');
  const unknownWarning = preview.openingCutover.warnings.find(w => w.code === 'pending-remains-unknown');
  ok(unknownWarning && unknownWarning.observedValue === null,
    'preserved UNKNOWN observedValue is null, not 0');
  ok(!codes(preview.openingCutover.blockers).includes('pending-state-change-unresolved'),
    'unchanged UNKNOWN is not a pending-change blocker');
}

console.log('\n=== CASE 7b — proven zero cannot silently write UNKNOWN pending to 0 ===');
{
  const data = makeData({
    asOf: '2026-08-16',
    debts: [
      {
        id: 'mortgage', balance: 500000, pending: 0, secured: true,
        interestTreatment: 'paid-in-payment', limit: null,
      },
      {
        id: 'cashback', balance: 4000, pending: null, pendingUnknown: true,
        secured: false, limit: 5000,
      },
    ],
  });
  const map = extendMap([{
    providerAccountId: 4105, collection: 'debts', id: 'cashback', role: 'revolving-credit',
  }]);
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4105, name: 'Cash Back', type: 'credit', subtype: 'credit_card',
      balance: 4000, limit: 5000, evidenceDate: '2026-08-18',
    }),
  ]), [], completePendingCoverage());
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', data);
  const before = hashFile(dest);
  const { report, preview } = previewAt(data, payload, { accountMap: map, cutoverAsOf: '2026-08-18' });
  const pending = report.observations.find(o => o.observationId === 'lm-4105-pending');
  ok(pending && near(pending.evidenceValue, 0) && pending.unknown !== true,
    'provider packet can prove numeric zero without writing it');
  ok(!codes(preview.openingCutover.blockers).includes('pending-state-change-unresolved'),
    'UNKNOWN -> proven 0 is a cutover proposal, not a silent write');
  const pendingHit = (preview.openingCutover.pendingTransitions || []).find(row => row.locator === 'debts:cashback#pending');
  ok(pendingHit && pendingHit.currentUnknown === true && near(pendingHit.proposedValue, 0),
    'cutover proposal carries UNKNOWN -> proven 0');
  ok(!preview.proposed.some(row => /pending/.test(String(row.locator || ''))),
    'no pending write is proposed on the ordinary posted preview for UNKNOWN → 0');
  ok(hashFile(dest) === before, 'UNKNOWN pending is not written to 0 without cutover approval');
}

console.log('\n=== CASE 8 — stale known pending is not current ===');
{
  const data = makeData({
    asOf: '2026-08-16',
    debts: [
      {
        id: 'mortgage', balance: 500000, pending: 0, secured: true,
        interestTreatment: 'paid-in-payment', limit: null,
      },
      {
        id: 'tdcc', balance: 1700, pending: 40, pendingUnknown: false,
        secured: false, limit: 2000,
      },
    ],
  });
  const map = extendMap([{
    providerAccountId: 4104, collection: 'debts', id: 'tdcc', role: 'revolving-credit',
  }]);
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4104, name: 'Personal Card', type: 'credit', subtype: 'credit_card',
      balance: 1700, limit: 2000, evidenceDate: '2026-08-18',
    }),
  ]));
  const { preview } = previewAt(data, payload, { accountMap: map, cutoverAsOf: '2026-08-18' });
  ok(preview.openingCutover.status === 'BLOCKED', 'unproven known pending fails closed');
  ok(codes(preview.openingCutover.blockers).includes('pending-freshness-unproven'),
    'blocker code is pending-freshness-unproven');
  ok(!preview.proposed.some(row => /pending/.test(String(row.locator))),
    'stale pending is not treated as a posted write');
}

console.log('\n=== CASE 8a — proven zero pending is candidate-date evidence ===');
{
  const data = makeData({
    asOf: '2026-08-16',
    debts: [
      {
        id: 'mortgage', balance: 500000, pending: 0, secured: true,
        interestTreatment: 'paid-in-payment', limit: null,
      },
      {
        id: 'tdcc', balance: 1700, pending: 0, pendingUnknown: false,
        secured: false, limit: 2000,
      },
      {
        id: 'mbna', balance: 8000, pending: 0, pendingUnknown: false,
        secured: false, limit: 8000,
      },
    ],
  });
  const map = extendMap([
    { providerAccountId: 4104, collection: 'debts', id: 'tdcc', role: 'revolving-credit' },
    { providerAccountId: 4109, collection: 'debts', id: 'mbna', role: 'revolving-credit' },
  ]);
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4104, name: 'Personal Card', type: 'credit', subtype: 'credit_card',
      balance: 1700, limit: 2000, evidenceDate: '2026-08-18',
    }),
    accountRow({
      id: 4109, name: 'MBNA', type: 'credit', subtype: 'credit_card',
      balance: 8000, limit: 8000, evidenceDate: '2026-08-18',
    }),
  ]), [], completePendingCoverage());
  const { report, preview } = previewAt(data, payload, { accountMap: map, cutoverAsOf: '2026-08-18' });
  const tdcc = report.observations.find(o => o.observationId === 'lm-4104-pending');
  const mbna = report.observations.find(o => o.observationId === 'lm-4109-pending');
  ok(tdcc && near(tdcc.evidenceValue, 0) && tdcc.unknown !== true,
    'TD Personal candidate-date pending observation is proven 0');
  ok(mbna && near(mbna.evidenceValue, 0) && mbna.unknown !== true,
    'MBNA candidate-date pending observation is proven 0');
  ok(!codes(preview.openingCutover.blockers).includes('pending-freshness-unproven'),
    'proven zero is not pending-freshness-unproven');
  ok(!preview.proposed.some(row => /pending/.test(String(row.locator || ''))),
    'proven zero does not propose a pending write');
}

console.log('\n=== CASE 8b — empty bounded window is not proven zero ===');
{
  const data = makeData({
    asOf: '2026-08-16',
    debts: [
      {
        id: 'mortgage', balance: 500000, pending: 0, secured: true,
        interestTreatment: 'paid-in-payment', limit: null,
      },
      {
        id: 'tdcc', balance: 1700, pending: 0, pendingUnknown: false,
        secured: false, limit: 2000,
      },
      {
        id: 'mbna', balance: 8000, pending: 0, pendingUnknown: false,
        secured: false, limit: 8000,
      },
    ],
  });
  const map = extendMap([
    { providerAccountId: 4104, collection: 'debts', id: 'tdcc', role: 'revolving-credit' },
    { providerAccountId: 4109, collection: 'debts', id: 'mbna', role: 'revolving-credit' },
  ]);
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4104, name: 'Personal Card', type: 'credit', subtype: 'credit_card',
      balance: 1700, limit: 2000, evidenceDate: '2026-08-18',
    }),
    accountRow({
      id: 4109, name: 'MBNA', type: 'credit', subtype: 'credit_card',
      balance: 8000, limit: 8000, evidenceDate: '2026-08-18',
    }),
  ]));
  const { report, preview } = previewAt(data, payload, { accountMap: map, cutoverAsOf: '2026-08-18' });
  ok(!report.observations.some(o => o.fact === 'pending' && (o.cardId === 'tdcc' || o.cardId === 'mbna')),
    'bounded empty packet does not invent pending 0 observations');
  ok(preview.openingCutover.status === 'BLOCKED',
    'unproven zero pending fails closed');
  const unproven = preview.openingCutover.blockers.filter(b => b.code === 'pending-freshness-unproven');
  ok(unproven.some(b => b.locator === 'debts:tdcc#pending'),
    'TD Personal remains pending-freshness-unproven');
  ok(unproven.some(b => b.locator === 'debts:mbna#pending'),
    'MBNA remains pending-freshness-unproven');
}

console.log('\n=== CASE 8c — dated is_pending query cannot prove zero ===');
{
  const data = makeData({
    asOf: '2026-08-16',
    debts: [
      {
        id: 'mortgage', balance: 500000, pending: 0, secured: true,
        interestTreatment: 'paid-in-payment', limit: null,
      },
      {
        id: 'tdcc', balance: 1700, pending: 0, pendingUnknown: false,
        secured: false, limit: 2000,
      },
    ],
  });
  const map = extendMap([
    { providerAccountId: 4104, collection: 'debts', id: 'tdcc', role: 'revolving-credit' },
  ]);
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4104, name: 'Personal Card', type: 'credit', subtype: 'credit_card',
      balance: 1700, limit: 2000, evidenceDate: '2026-08-18',
    }),
  ]), [], {
    pendingCoverage: {
      complete: true,
      basis: 'is_pending-unbounded',
      hasMore: false,
      startDate: '2026-08-04',
      endDate: '2026-08-18',
    },
  });
  const { report, preview } = previewAt(data, payload, { accountMap: map, cutoverAsOf: '2026-08-18' });
  ok(!report.observations.some(o => o.observationId === 'lm-4104-pending'),
    'dated pending query does not emit proven zero');
  ok(codes(preview.openingCutover.blockers).includes('pending-freshness-unproven'),
    'a date-bounded pending query cannot unblock zero pending');
}

console.log('\n=== CASE 9 — same-day no winner ===');
{
  const data = makeData({ asOf: '2026-08-18' });
  const accounts = matchingPostedAccounts(data, '2026-08-18').map(row => (
    row.id === 4108 ? Object.assign({}, row, { balance: 500112.7 }) : row
  ));
  const payload = makePayload('2026-08-18', accounts);
  const { preview } = previewAt(data, payload, { cutoverAsOf: '2026-08-18' });
  ok(preview.openingCutover.status === 'BLOCKED', 'same-day CHANGE with no winner is BLOCKED');
  ok(codes(preview.openingCutover.blockers).includes('same-day-no-winner'),
    'blocker code is same-day-no-winner');
  ok(!preview.proposed.some(row => row.locator === 'debts:mortgage'),
    'no winner is chosen into the proposed set');
  const row = freshness(preview.openingCutover, 'debts:mortgage');
  ok(row && row.dateRelation === 'same-day', 'incumbent date relation remains same-day');
}

console.log('\n=== CASE 10 — same-day Forecast event represented ===');
{
  const requested = '2026-08-18';
  const data = makeData({
    asOf: '2026-08-16',
    income: [{
      id: 'payroll',
      label: 'Payroll',
      frequency: 'once',
      date: requested,
      amount: 1000,
      confidence: 'confirmed',
    }],
  });
  const identity = {
    rules: [{
      eventId: 'payroll',
      payeePattern: 'SEASPAN',
      atlasAccountId: 'chequing-a',
      direction: 'credit',
    }],
    billPaymentPayees: [],
  };
  const payload = makePayload(requested, matchingPostedAccounts(data, requested), [{
    id: 88010,
    account_id: 4101,
    date: requested,
    amount: -1000,
    payee: 'SEASPAN PAYROLL',
    is_pending: false,
    status: 'reviewed',
  }]);
  const scheduled = Forecast.expandEvents(data.plan, requested, requested, {})
    .filter(e => e.id === 'payroll' && e.date === requested);
  ok(scheduled.length === 1, 'independent Forecast schedule has payroll on the requested date');
  const { preview } = previewAt(data, payload, { identity, cutoverAsOf: requested });
  const event = (preview.openingCutover.sameDayEvents || []).find(e => e.id === 'payroll');
  ok(event && event.representation === 'REPRESENTED',
    'preflight reports REPRESENTED for the proven same-day event');
  ok(event && event.representedEventsCandidate
    && event.representedEventsCandidate.id === 'payroll'
    && event.representedEventsCandidate.date === requested,
    'future representedEvents candidate is exposed as id/date only');
  ok(!codes(preview.openingCutover.blockers).includes('same-day-event-representation-unknown'),
    'represented same-day event is not an unknown blocker');
  ok((data.plan.opening.representedEvents || []).length === 0,
    'no representedEvents write occurred on the input document');
}

console.log('\n=== CASE 11 — same-day Forecast event unknown ===');
{
  const requested = '2026-08-18';
  const data = makeData({
    asOf: '2026-08-16',
    bills: [{
      id: 'rent',
      label: 'Rent',
      frequency: 'once',
      date: requested,
      amount: 500,
      confidence: 'confirmed',
    }],
  });
  const payload = makePayload(requested, matchingPostedAccounts(data, requested));
  const scheduled = Forecast.expandEvents(data.plan, requested, requested, {})
    .filter(e => e.id === 'rent' && e.date === requested && e.kind !== 'noncash');
  ok(scheduled.length === 1, 'independent Forecast schedule has the rent cash event');
  const { preview } = previewAt(data, payload, { cutoverAsOf: requested });
  const event = (preview.openingCutover.sameDayEvents || []).find(e => e.id === 'rent');
  ok(event && event.representation === 'UNKNOWN', 'unproven same-day event is UNKNOWN');
  ok(preview.openingCutover.status === 'BLOCKED', 'unknown representation blocks the cutover');
  ok(codes(preview.openingCutover.blockers).includes('same-day-event-representation-unknown'),
    'blocker code is same-day-event-representation-unknown');
}

console.log('\n=== CASE 12 — historical represented candidate is not promoted ===');
{
  const requested = '2026-08-18';
  const data = makeData({
    asOf: '2026-08-16',
    income: [{
      id: 'payroll',
      label: 'Payroll',
      frequency: 'once',
      date: '2026-08-14',
      amount: 1000,
      confidence: 'confirmed',
    }],
  });
  const identity = {
    rules: [{
      eventId: 'payroll',
      payeePattern: 'SEASPAN',
      atlasAccountId: 'chequing-a',
      direction: 'credit',
    }],
    billPaymentPayees: [],
  };
  const payload = makePayload(requested, matchingPostedAccounts(data, requested), [{
    id: 88014,
    account_id: 4101,
    date: '2026-08-14',
    amount: -1000,
    payee: 'SEASPAN PAYROLL',
    is_pending: false,
    status: 'reviewed',
  }]);
  const { preview } = previewAt(data, payload, { identity, cutoverAsOf: requested });
  const promoted = (preview.openingCutover.sameDayEvents || []).some(e =>
    e.id === 'payroll' && e.date === requested);
  ok(!promoted, 'historical payroll is not re-dated onto the requested opening');
  const historical = (preview.openingCutover.sameDayEvents || []).find(e =>
    e.id === 'payroll' && e.representation === 'REPRESENTED');
  ok(!historical, 'historical identity hit is not a requested-opening representedEvents candidate');
  ok(codes(preview.openingCutover.warnings).includes('historical-represented-candidate-not-promoted'),
    'historical candidate is reported as not promoted');
}

console.log('\n=== CASE 13 — carried unresolved once obligation keeps its scheduled date ===');
{
  const opening = '2026-08-16';
  const requested = '2026-08-18';
  const owed = 100;
  const data = makeData({
    asOf: opening,
    bills: [{
      id: 'owed',
      label: 'Unresolved once obligation',
      frequency: 'once',
      date: opening,
      amount: owed,
      confidence: 'confirmed',
    }],
  });
  const payload = makePayload(requested, matchingPostedAccounts(data, requested));
  const independentDates = data.plan.bills[0].date > requested
    ? []
    : [data.plan.bills[0].date];
  ok(independentDates[0] === opening, 'independent once date is the original scheduled date');
  const events = Forecast.expandEvents(data.plan, requested, requested, {});
  const carried = events.filter(e => e.id === 'owed');
  ok(carried.length === 1 && carried[0].date === opening,
    'Forecast still emits the once obligation on its original date');
  const { preview } = previewAt(data, payload, { cutoverAsOf: requested });
  const summary = preview.openingCutover.carriedUnresolvedOutflows;
  ok(summary && summary.count === 1, 'preflight reports one carried unresolved outflow');
  ok(summary && near(summary.total, -owed), 'carried total is the original amount');
  ok(summary.items[0].id === 'owed' && summary.items[0].scheduledDate === opening,
    'preflight keeps the original scheduled date');
  ok(summary.items[0].scheduledDate !== requested, 'no new due date is invented');
  ok(!codes(preview.openingCutover.blockers).includes('carried-unresolved-outflow'),
    'carried unresolved outflows are not blockers merely because they are past-dated');
}

console.log('\n=== CASE 14 — unmapped provider account stays sanitized ===');
{
  const data = makeData({ asOf: '2026-08-16' });
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4199, name: 'Unmapped Extra', type: 'cash',
      balance: 50, evidenceDate: '2026-08-18',
    }),
  ]));
  const { preview } = previewAt(data, payload, { cutoverAsOf: '2026-08-18' });
  ok(preview.openingCutover.unmappedCount === 1, 'unmappedCount is 1');
  ok(codes(preview.openingCutover.warnings).includes('unmapped-account-materiality-unknown'),
    'materiality remains unknown');
  const blob = JSON.stringify(preview);
  ok(!/"providerAccountId"\s*:/.test(blob), 'unmapped output has no providerAccountId');
  ok(!preview.proposed.some(row => /4199/.test(JSON.stringify(row))),
    'unmapped account is not guessed into a proposed household cash write');
}

console.log('\n=== CASE 15 — sanitization ===');
{
  const data = makeData({
    asOf: '2026-08-16',
    income: [{
      id: 'payroll',
      label: 'Payroll',
      frequency: 'once',
      date: '2026-08-18',
      amount: 1000,
      confidence: 'confirmed',
    }],
  });
  const identity = {
    rules: [{
      eventId: 'payroll',
      payeePattern: 'SEASPAN',
      atlasAccountId: 'chequing-a',
      direction: 'credit',
    }],
    billPaymentPayees: [],
  };
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4198, name: 'Unmapped Two', type: 'cash',
      balance: 12, evidenceDate: '2026-08-18',
    }),
  ]), [{
    id: 88018,
    account_id: 4101,
    date: '2026-08-18',
    amount: -1000,
    payee: 'SEASPAN PAYROLL',
    is_pending: false,
    status: 'reviewed',
  }]);
  const { preview } = previewAt(data, payload, { identity, cutoverAsOf: '2026-08-18' });
  const blob = JSON.stringify(preview);
  ok(!/"providerAccountId"\s*:/.test(blob), 'no providerAccountId in preflight output');
  ok(!/"providerTransactionId"\s*:/.test(blob), 'no providerTransactionId in preflight output');
  ok(!/Bearer\s+\S+/.test(blob), 'no Bearer token in preflight output');
  ok(!/LUNCHMONEY_ACCESS_TOKEN/.test(blob), 'no LUNCHMONEY_ACCESS_TOKEN in preflight output');
  ok(C.identityProofLooksSanitized(preview), 'shared sanitizer accepts the cutover preview');
}

console.log('\n=== STRUCTURE — blocked packet shaped like the 2026-08-18 diagnostic ===');
{
  const opening = '2026-08-16';
  const requested = '2026-08-18';
  const data = makeData({
    asOf: opening,
    cash: { 'chequing-b': 200 },
    bills: [{
      id: 'owed',
      label: 'Unknown once bill',
      frequency: 'once',
      date: opening,
      amount: 80,
      confidence: 'confirmed',
    }],
    debts: [
      {
        id: 'mortgage', balance: 500000, pending: 0, secured: true,
        interestTreatment: 'paid-in-payment', limit: null,
      },
      {
        id: 'triangle', balance: 13197, pending: 15.62, secured: false, limit: 13500,
      },
      {
        id: 'travelvisa', balance: 800, pending: 250, secured: false, limit: 1100,
      },
    ],
  });
  const map = extendMap([
    { providerAccountId: 4110, collection: 'debts', id: 'triangle', role: 'revolving-credit' },
    { providerAccountId: 4106, collection: 'debts', id: 'travelvisa', role: 'revolving-credit' },
  ]);
  const payload = makePayload(requested, [
    accountRow({
      id: 4101, name: 'Chequing A', type: 'cash', subtype: 'checking',
      balance: 1000, evidenceDate: requested,
    }),
    accountRow({
      id: 4102, name: 'Chequing B', type: 'cash', subtype: 'checking',
      balance: 190, evidenceDate: requested,
    }),
    accountRow({
      id: 4103, name: 'Savings', type: 'cash', subtype: 'savings',
      balance: 50, evidenceDate: requested,
    }),
    accountRow({
      id: 4108, name: 'Mortgage', type: 'loan', subtype: 'mortgage',
      balance: 500000, evidenceDate: requested,
    }),
    accountRow({
      id: 4110, name: 'Triangle', type: 'credit', subtype: 'credit_card',
      balance: 13309.7, limit: 13500, evidenceDate: opening,
    }),
    accountRow({
      id: 4106, name: 'Travel Visa', type: 'credit', subtype: 'credit_card',
      balance: 800, limit: 1100, evidenceDate: requested,
    }),
    accountRow({
      id: 4196, name: 'Held Elsewhere One', type: 'cash',
      balance: 10, evidenceDate: requested,
    }),
    accountRow({
      id: 4197, name: 'Held Elsewhere Two', type: 'cash',
      balance: 20, evidenceDate: requested,
    }),
  ], [{
    id: 88066,
    account_id: 4106,
    date: requested,
    amount: 342.65,
    payee: 'Merchant Pending',
    is_pending: true,
    status: 'unreviewed',
  }]);
  const { preview } = previewAt(data, payload, { accountMap: map, cutoverAsOf: requested });
  const cutover = preview.openingCutover;
  ok(cutover.status === 'BLOCKED', 'structured diagnostic is BLOCKED');
  ok(freshness(cutover, 'cash:chequing-a').freshForRequestedAsOf === true,
    'current spendable cash evidence can be dated on the requested opening');
  ok(preview.proposed.some(row => row.locator === 'cash:chequing-b'),
    'one newer posted cash CHANGE is visible');
  ok(codes(cutover.blockers).includes('pending-state-change-unresolved'),
    'one card pending CHANGE blocks');
  ok(freshness(cutover, 'debts:triangle').freshForRequestedAsOf === false,
    'matching-or-conflicting older posted evidence is not reported as fresh');
  ok(codes(cutover.blockers).includes('stale-posted-opening-evidence'),
    'stale posted evidence blocks');
  ok(codes(cutover.blockers).includes('same-day-no-winner'),
    'older same-day conflict without a requested-date winner still blocks');
  ok(cutover.unmappedCount === 2, 'two unmapped provider accounts are counted');
  ok(!(cutover.sameDayEvents || []).some(e => e.representation === 'REPRESENTED'),
    'no current-opening representedEvent candidate for the requested date');
  ok((cutover.sameDayEvents || []).length === 0,
    'no true Forecast cash event is scheduled on the requested date');
  ok(cutover.carriedUnresolvedOutflows.count === 1
    && cutover.carriedUnresolvedOutflows.items[0].scheduledDate === opening,
    'prior once obligation remains reserved across the opening advance');
}

console.log('\n=== CASE TZ — UTC midnight is not the household financial date ===');
{
  const INSTANT = '2026-08-19T01:06:40.929Z';
  const requested = '2026-08-18';
  // Independent of Forecast.financialDate: August 2026 is PDT (UTC-7).
  const independent = new Date(Date.parse(INSTANT) - 7 * 3600 * 1000)
    .toISOString().slice(0, 10);
  ok(independent === requested,
    'independent PDT offset of 2026-08-19T01:06:40.929Z is 2026-08-18');

  const data = makeData({ asOf: '2026-08-16' });
  const accounts = matchingPostedAccounts(data, requested).map(row => (
    Object.assign({}, row, { updated_at: INSTANT, balance_last_update: INSTANT })
  ));
  const payload = {
    provider: 'lunchmoney',
    fetchedAt: INSTANT,
    source: 'Synthetic timezone-boundary fixture. Not a live institution pull.',
    accounts,
    transactions: [],
  };
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', data);
  const before = hashFile(dest);
  const { report, preview } = previewAt(data, payload, { cutoverAsOf: requested });
  const cashObs = (report.observations || []).find(o =>
    o && o.canonical && o.canonical.id === 'chequing-a' && !o.fact);
  ok(cashObs && cashObs.evidenceDate === requested && cashObs.observedAsOf === requested,
    'observe evidence date is the household date, not the UTC date prefix',
    cashObs && cashObs.evidenceDate);
  const cash = freshness(preview.openingCutover, 'cash:chequing-a');
  ok(cash && cash.evidenceDate === requested,
    'posted evidence fetched at 01:06Z is dated 2026-08-18',
    cash && cash.evidenceDate);
  ok(cash && cash.freshForRequestedAsOf === true,
    'that instant is eligible candidate-date evidence for 18 August');
  ok(!codes(preview.openingCutover.blockers).includes('stale-posted-opening-evidence'),
    'UTC date crossing does not emit stale-posted-opening-evidence');
  ok(preview.openingCutover.writesOpening === false
    && preview.writesCanonicalState === false,
    'timezone-boundary preflight still writes nothing');
  ok(hashFile(dest) === before, 'temp data.json is byte-identical after the boundary preview');

  const nextInstant = '2026-08-19T07:06:40.929Z';
  const independentNext = new Date(Date.parse(nextInstant) - 7 * 3600 * 1000)
    .toISOString().slice(0, 10);
  ok(independentNext === '2026-08-19',
    'independent PDT offset of 07:06Z is 2026-08-19');
  const nextAccounts = matchingPostedAccounts(data, '2026-08-19').map(row => (
    Object.assign({}, row, { updated_at: nextInstant, balance_last_update: nextInstant })
  ));
  const nextPreview = previewAt(data, {
    provider: 'lunchmoney',
    fetchedAt: nextInstant,
    source: payload.source,
    accounts: nextAccounts,
    transactions: [],
  }, { cutoverAsOf: requested });
  const nextCash = (nextPreview.report.observations || []).find(o =>
    o && o.canonical && o.canonical.id === 'chequing-a' && !o.fact);
  ok(nextCash && nextCash.evidenceDate === '2026-08-19',
    'an instant that is 19 August in Vancouver remains 19 August');
  ok(codes(nextPreview.preview.openingCutover.blockers).includes('stale-posted-opening-evidence'),
    'genuine 19 August evidence is not treated as 18 August');

  const stalePayload = makePayload(requested, matchingPostedAccounts(data, '2026-08-16'));
  stalePayload.fetchedAt = INSTANT;
  const stale = previewAt(data, stalePayload, { cutoverAsOf: requested });
  const mortgage = freshness(stale.preview.openingCutover, 'debts:mortgage');
  ok(mortgage && mortgage.evidenceDate === '2026-08-16'
    && mortgage.freshForRequestedAsOf === false,
    'older provider updated_at remains stale even when fetched after UTC midnight');
  ok(codes(stale.preview.openingCutover.blockers).includes('stale-posted-opening-evidence'),
    'genuinely older posted evidence still blocks');
  ok(stale.preview.openingCutover.writesOpening === false, 'stale packet still writes nothing');

  const applied = runCli([
    '--fixture', writeJson(dir, 'tz-payload.json', payload),
    '--map', writeJson(dir, 'tz-map.json', BASE_MAP),
    '--data', dest,
    '--cutover-as-of', requested,
  ]);
  ok(applied.code === 0, 'read-only boundary preflight CLI exits 0');
  ok(hashFile(dest) === before, 'CLI cutover at the timezone boundary writes nothing');
  ok(hashFile(LIVE_DATA) === liveHash, 'live data.json is unchanged by the timezone case');
}

console.log('\n=== CASE A — posted-balance evidence uses balance_as_of, not updated_at ===');
{
  const data = makeData({
    asOf: '2026-08-16',
    debts: [
      { id: 'mortgage', balance: 500000, pending: 0, secured: true, interestTreatment: 'paid-in-payment', limit: null },
      revolvingDebt({ id: 'triangle', balance: 13197, limit: 13500 }),
    ],
  });
  const map = extendMap([{
    providerAccountId: 4110, collection: 'debts', id: 'triangle', role: 'revolving-credit',
  }]);
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4110, name: 'Triangle', type: 'credit', subtype: 'credit_card',
      balance: 13495.32, limit: 13500, evidenceDate: '2026-08-16',
      updatedAt: '2026-08-16T20:44:19.898Z',
      balanceAsOf: '2026-08-19T03:25:33.904Z',
    }),
  ]));
  const { report, preview } = previewAt(data, payload, { accountMap: map, cutoverAsOf: '2026-08-18' });
  const obs = (report.observations || []).find(o => o && o.fact === 'posted-balance' && o.cardId === 'triangle');
  const row = freshness(preview.openingCutover, 'debts:triangle');
  ok(obs && obs.evidenceDate === '2026-08-18' && obs.observedAsOf === '2026-08-18',
    'CASE A: posted evidenceDate is balance_as_of 2026-08-18, not updated_at 2026-08-16',
    obs && obs.evidenceDate);
  ok(row && row.evidenceDate === '2026-08-18',
    'CASE A: cutover posted evidenceDate is 2026-08-18');
  ok(row && row.freshForRequestedAsOf === true, 'CASE A: 2026-08-18 posted evidence is exact-day fresh');
  ok(row && row.freshnessBasis === C.FRESHNESS_EXACT_DAY, 'CASE A: freshness basis is exact-day');
}

console.log('\n=== CASE B — statement cadence accepts without rewriting evidenceDate ===');
{
  const data = makeData({
    asOf: '2026-08-16',
    debts: [
      { id: 'mortgage', balance: 500000, pending: 0, secured: true, interestTreatment: 'paid-in-payment', limit: null },
      revolvingDebt({ id: 'triangle', balance: 13197, limit: 13500 }),
    ],
  });
  const map = extendMap([{
    providerAccountId: 4110, collection: 'debts', id: 'triangle', role: 'revolving-credit',
  }]);
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4110, name: 'Triangle', type: 'credit', subtype: 'credit_card',
      balance: 13495.32, limit: 13500, evidenceDate: '2026-08-17',
      updatedAt: '2026-08-16T20:44:19.898Z',
      balanceAsOf: '2026-08-17T17:55:00.000Z',
    }),
  ]));
  const { preview } = previewAt(data, payload, { accountMap: map, cutoverAsOf: '2026-08-18' });
  const row = freshness(preview.openingCutover, 'debts:triangle');
  ok(row && row.evidenceDate === '2026-08-17',
    'CASE B: evidenceDate stays 2026-08-17 and is not rewritten to 2026-08-18',
    row && row.evidenceDate);
  ok(row && row.freshForRequestedAsOf === true,
    'CASE B: Triangle statement-day evidence is accepted for 2026-08-18');
  ok(row && row.freshnessBasis === C.FRESHNESS_STATEMENT_CADENCE,
    'CASE B: freshness basis names owner-approved monthly statement cadence');
  ok(!codes(preview.openingCutover.blockers).includes('stale-posted-opening-evidence')
    || codes(preview.openingCutover.blockers).every(code => {
      const hit = (preview.openingCutover.blockers || []).find(b => b.code === 'stale-posted-opening-evidence' && b.locator === 'debts:triangle');
      return !hit;
    }),
    'CASE B: Triangle is not stale-posted-opening-evidence solely for missing exact-day');
  ok(!(preview.openingCutover.accountFreshness || []).some(r => r.locator === 'debts:triangle' && r.evidenceDate === '2026-08-18'),
    'CASE B: no Triangle row is relabelled 2026-08-18');
}

console.log('\n=== CASE C — Triangle current statement cycle remains acceptable after the 17th ===');
{
  ok(C.currentStatementCycleStart('2026-08-18', 17) === '2026-08-17',
    'independent cycle start for 18 Aug / day 17 is 17 Aug');
  ok(C.nextStatementDate('2026-08-17', 17) === '2026-09-17',
    'independent next Triangle statement day is 17 Sep');
  ok(C.statementCadenceAccepts('triangle', '2026-08-17', '2026-08-18') === true,
    '17 Aug Triangle evidence is in the current cycle on 18 Aug');
  const data = makeData({
    asOf: '2026-08-16',
    debts: [
      { id: 'mortgage', balance: 500000, pending: 0, secured: true, interestTreatment: 'paid-in-payment', limit: null },
      revolvingDebt({ id: 'triangle', balance: 13197, limit: 13500 }),
    ],
  });
  const map = extendMap([{
    providerAccountId: 4110, collection: 'debts', id: 'triangle', role: 'revolving-credit',
  }]);
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4110, name: 'Triangle', type: 'credit', subtype: 'credit_card',
      balance: 13495.32, limit: 13500, evidenceDate: '2026-08-17',
    }),
  ]));
  const { preview } = previewAt(data, payload, { accountMap: map, cutoverAsOf: '2026-08-18' });
  const row = freshness(preview.openingCutover, 'debts:triangle');
  ok(row && row.freshForRequestedAsOf === true && row.evidenceDate === '2026-08-17',
    'CASE C: current-cycle Triangle observation is fresh without exact-day');
  ok(row && row.freshnessBasis === C.FRESHNESS_STATEMENT_CADENCE,
    'CASE C: freshness basis is owner-approved statement cadence');
  ok(!(preview.openingCutover.blockers || []).some(b =>
    b.code === 'stale-posted-opening-evidence' && b.locator === 'debts:triangle'),
    'CASE C: no stale-posted-opening-evidence for current-cycle Triangle');
}

console.log('\n=== CASE D — Triangle prior cycle is not current on the next 17th ===');
{
  ok(C.statementCadenceAccepts('triangle', '2026-08-17', '2026-09-17') === false,
    'independent: 17 Aug evidence is not current on 17 Sep');
  const data = makeData({
    asOf: '2026-08-16',
    debts: [
      { id: 'mortgage', balance: 500000, pending: 0, secured: true, interestTreatment: 'paid-in-payment', limit: null },
      revolvingDebt({ id: 'triangle', balance: 13197, limit: 13500 }),
    ],
  });
  const map = extendMap([{
    providerAccountId: 4110, collection: 'debts', id: 'triangle', role: 'revolving-credit',
  }]);
  const payload = makePayload('2026-09-17', matchingPostedAccounts(data, '2026-09-17').concat([
    accountRow({
      id: 4110, name: 'Triangle', type: 'credit', subtype: 'credit_card',
      balance: 13495.32, limit: 13500, evidenceDate: '2026-08-17',
    }),
  ]));
  const { preview } = previewAt(data, payload, { accountMap: map, cutoverAsOf: '2026-09-17' });
  const row = freshness(preview.openingCutover, 'debts:triangle');
  ok(row && row.evidenceDate === '2026-08-17',
    'CASE D: prior-cycle evidenceDate is unchanged at 2026-08-17');
  ok(row && row.freshForRequestedAsOf === false,
    'CASE D: 17 Aug Triangle evidence is not current on the next 17th');
  ok((preview.openingCutover.blockers || []).some(b =>
    b.code === 'stale-posted-opening-evidence' && b.locator === 'debts:triangle'),
    'CASE D: Atlas fails closed until new Triangle statement evidence exists');
  ok(preview.openingCutover.status === 'BLOCKED', 'CASE D: cutover is BLOCKED');
}

console.log('\n=== CASE E — MBNA monthly day 8 ===');
{
  ok(C.ownerStatementCadence('mbna') && C.ownerStatementCadence('mbna').day === 8,
    'MBNA cadence is keyed by canonical id mbna, day 8');
  ok(C.statementCadenceAccepts('mbna', '2026-08-08', '2026-08-18') === true,
    '8 Aug MBNA evidence is in the current cycle on 18 Aug');
  ok(C.statementCadenceAccepts('mbna', '2026-08-08', '2026-09-08') === false,
    '8 Aug MBNA evidence is not current on the next 8th');
  const data = makeData({
    asOf: '2026-08-16',
    debts: [
      { id: 'mortgage', balance: 500000, pending: 0, secured: true, interestTreatment: 'paid-in-payment', limit: null },
      revolvingDebt({ id: 'mbna', balance: 8003.61, limit: 8000 }),
    ],
  });
  const map = extendMap([{
    providerAccountId: 4111, collection: 'debts', id: 'mbna', role: 'revolving-credit',
  }]);
  const inCycle = previewAt(data, makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4111, name: 'MBNA', type: 'credit', subtype: 'credit_card',
      balance: 7875.99, limit: 8000, evidenceDate: '2026-08-08',
    }),
  ])), { accountMap: map, cutoverAsOf: '2026-08-18' });
  const inRow = freshness(inCycle.preview.openingCutover, 'debts:mbna');
  ok(inRow && inRow.evidenceDate === '2026-08-08' && inRow.freshForRequestedAsOf === true,
    'CASE E: current-cycle MBNA evidence stays dated 8 Aug and is accepted on 18 Aug');
  ok(inRow && inRow.freshnessBasis === C.FRESHNESS_STATEMENT_CADENCE,
    'CASE E: MBNA freshness basis is owner-approved statement cadence');
  ok(!(inCycle.preview.openingCutover.blockers || []).some(b =>
    b.code === 'stale-posted-opening-evidence' && b.locator === 'debts:mbna'),
    'CASE E: current-cycle MBNA is not stale solely for missing exact-day');

  const nextCycle = previewAt(data, makePayload('2026-09-08', matchingPostedAccounts(data, '2026-09-08').concat([
    accountRow({
      id: 4111, name: 'MBNA', type: 'credit', subtype: 'credit_card',
      balance: 7875.99, limit: 8000, evidenceDate: '2026-08-08',
    }),
  ])), { accountMap: map, cutoverAsOf: '2026-09-08' });
  const nextRow = freshness(nextCycle.preview.openingCutover, 'debts:mbna');
  ok(nextRow && nextRow.evidenceDate === '2026-08-08' && nextRow.freshForRequestedAsOf === false,
    'CASE E: prior-cycle MBNA evidence is unchanged and not current on 8 Sep');
  ok((nextCycle.preview.openingCutover.blockers || []).some(b =>
    b.code === 'stale-posted-opening-evidence' && b.locator === 'debts:mbna'),
    'CASE E: Atlas fails closed on the next MBNA statement day without new evidence');
}

console.log('\n=== CASE F — normal live accounts keep exact-day freshness ===');
{
  ok(!C.ownerStatementCadence('cashback') && !C.ownerStatementCadence('tdcc')
    && !C.ownerStatementCadence('travelvisa') && !C.ownerStatementCadence('chequing-a'),
    'Cash Back and other live accounts are not on Triangle/MBNA cadence');
  const ids = Object.keys(C.OWNER_STATEMENT_CADENCE).sort();
  ok(ids.length === 2 && ids[0] === 'mbna' && ids[1] === 'triangle',
    'statement cadence is only triangle and mbna');
  const data = makeData({
    asOf: '2026-08-16',
    debts: [
      { id: 'mortgage', balance: 500000, pending: 0, secured: true, interestTreatment: 'paid-in-payment', limit: null },
      revolvingDebt({ id: 'cashback', balance: 4799.43, limit: 5000, pendingUnknown: true }),
    ],
  });
  const map = extendMap([{
    providerAccountId: 4112, collection: 'debts', id: 'cashback', role: 'revolving-credit',
  }]);
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4112, name: 'Cash Back', type: 'credit', subtype: 'credit_card',
      balance: 4799.43, limit: 5000, evidenceDate: '2026-08-16',
    }),
  ]));
  const { preview } = previewAt(data, payload, { accountMap: map, cutoverAsOf: '2026-08-18' });
  const row = freshness(preview.openingCutover, 'debts:cashback');
  ok(row && row.evidenceDate === '2026-08-16' && row.freshForRequestedAsOf === false,
    'CASE F: Cash Back with 16 Aug evidence is still stale for 18 Aug');
  ok((preview.openingCutover.blockers || []).some(b =>
    b.code === 'stale-posted-opening-evidence' && b.locator === 'debts:cashback'),
    'CASE F: live Cash Back still receives stale-posted-opening-evidence');
  const mortgage = freshness(preview.openingCutover, 'debts:mortgage');
  ok(mortgage && mortgage.freshForRequestedAsOf === true && mortgage.freshnessBasis === C.FRESHNESS_EXACT_DAY,
    'CASE F: mortgage exact-day freshness is unchanged');
}

console.log('\n=== CASE G — future evidence is not accepted for an earlier opening ===');
{
  ok(C.statementCadenceAccepts('triangle', '2026-08-19', '2026-08-18') === false,
    'independent: future Triangle evidence is not current-cycle for 18 Aug');
  const data = makeData({
    asOf: '2026-08-16',
    debts: [
      { id: 'mortgage', balance: 500000, pending: 0, secured: true, interestTreatment: 'paid-in-payment', limit: null },
      revolvingDebt({ id: 'triangle', balance: 13197, limit: 13500 }),
    ],
  });
  const map = extendMap([{
    providerAccountId: 4110, collection: 'debts', id: 'triangle', role: 'revolving-credit',
  }]);
  const payload = makePayload('2026-08-19', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4110, name: 'Triangle', type: 'credit', subtype: 'credit_card',
      balance: 13495.32, limit: 13500, evidenceDate: '2026-08-19',
      balanceAsOf: '2026-08-19T17:55:00.000Z',
    }),
  ]));
  const { preview } = previewAt(data, payload, { accountMap: map, cutoverAsOf: '2026-08-18' });
  const row = freshness(preview.openingCutover, 'debts:triangle');
  ok(row && row.evidenceDate === '2026-08-19',
    'CASE G: future evidenceDate stays 2026-08-19');
  ok(row && row.freshForRequestedAsOf === false,
    'CASE G: 19 Aug evidence is not accepted as 18 Aug opening evidence');
  ok((preview.openingCutover.blockers || []).some(b =>
    b.code === 'stale-posted-opening-evidence' && b.locator === 'debts:triangle'),
    'CASE G: future-dated posted evidence fails closed');
}

console.log('\n=== CASE H — demonstrated Triangle/MBNA live values, no write ===');
{
  const data = makeData({
    asOf: '2026-08-16',
    debts: [
      { id: 'mortgage', balance: 500000, pending: 0, secured: true, interestTreatment: 'paid-in-payment', limit: null },
      revolvingDebt({ id: 'triangle', balance: 13197, limit: 13500, pending: 15.62 }),
      revolvingDebt({ id: 'mbna', balance: 8003.61, limit: 8000, pending: 0 }),
    ],
  });
  const map = extendMap([
    { providerAccountId: 4110, collection: 'debts', id: 'triangle', role: 'revolving-credit' },
    { providerAccountId: 4111, collection: 'debts', id: 'mbna', role: 'revolving-credit' },
  ]);
  const dir = tempDir();
  const dest = writeJson(dir, 'data.json', data);
  const before = hashFile(dest);
  const payload = makePayload('2026-08-18', matchingPostedAccounts(data, '2026-08-18').concat([
    accountRow({
      id: 4110, name: 'Triangle', type: 'credit', subtype: 'credit_card',
      balance: 13495.32, limit: 13500, evidenceDate: '2026-08-16',
      updatedAt: '2026-08-16T20:44:19.898Z',
      balanceAsOf: '2026-08-19T03:25:33.904Z',
    }),
    accountRow({
      id: 4111, name: 'MBNA', type: 'credit', subtype: 'credit_card',
      balance: 7875.99, limit: 8000, evidenceDate: '2026-08-16',
      updatedAt: '2026-08-16T20:46:38.268Z',
      balanceAsOf: '2026-08-19T03:26:33.481Z',
    }),
  ]), [], completePendingCoverage());
  const { report, preview } = previewAt(data, payload, { accountMap: map, cutoverAsOf: '2026-08-18' });
  const triangle = freshness(preview.openingCutover, 'debts:triangle');
  const mbna = freshness(preview.openingCutover, 'debts:mbna');
  ok(triangle && near(triangle.observedValue, 13495.32) && triangle.evidenceDate === '2026-08-18',
    'CASE H: Triangle 13,495.32 is dated 2026-08-18 from balance_as_of');
  ok(mbna && near(mbna.observedValue, 7875.99) && mbna.evidenceDate === '2026-08-18',
    'CASE H: MBNA 7,875.99 is dated 2026-08-18 from balance_as_of');
  ok(triangle.freshForRequestedAsOf === true && mbna.freshForRequestedAsOf === true,
    'CASE H: neither Triangle nor MBNA is stale for 2026-08-18');
  ok(!(preview.openingCutover.blockers || []).some(b =>
    (b.locator === 'debts:triangle' || b.locator === 'debts:mbna')
    && (b.code === 'stale-posted-opening-evidence' || b.code === 'same-day-no-winner')),
    'CASE H: no stale or same-day-no-winner on the demonstrated posted observations');
  ok(preview.writesCanonicalState === false
    && preview.openingCutover.writesOpening === false
    && preview.canonicalWriteAuthorized === false,
    'CASE H: no value is written and cutover write is not authorized');
  ok(hashFile(dest) === before, 'CASE H: temp data.json is byte-identical');
  ok(hashFile(LIVE_DATA) === liveHash, 'CASE H: live data.json is unchanged');
  const triangleObs = (report.observations || []).find(o => o && o.fact === 'posted-balance' && o.cardId === 'triangle');
  const mbnaObs = (report.observations || []).find(o => o && o.fact === 'posted-balance' && o.cardId === 'mbna');
  ok(triangleObs && triangleObs.evidenceDate === '2026-08-18'
    && mbnaObs && mbnaObs.evidenceDate === '2026-08-18',
    'CASE H: observe-layer posted dates follow balance_as_of');
}

console.log('\n=== invariants — previewId, schema gate, live bytes ===');
{
  ok(C.isIsoDate('2026-08-18') === true && C.isIsoDate('2026-08-18T18:00:00.000Z') === false,
    'cutover date is explicit YYYY-MM-DD, not fetchedAt');
  const locators = C.requiredPostedLocators(makeData({
    debts: [
      { id: 'alpha', balance: 1 },
      { id: 'beta', balance: 2 },
    ],
  })).map(row => row.locator);
  ok(locators.includes('cash:chequing-a') && locators.includes('debts:alpha')
    && locators.includes('debts:beta') && !locators.includes('debts:triangle'),
    'required posted debts are derived from canonical data, not hard-coded names');
  ok(hashFile(LIVE_DATA) === liveHash, 'live data.json hash is unchanged after the suite');
}

console.log('\n' + (failures ? `${failures} failure(s)` : 'All opening-cutover preflight checks passed'));
if (hashFile(LIVE_DATA) !== liveHash) {
  console.log('LIVE data.json changed — failing closed');
  process.exit(1);
}
process.exit(failures ? 1 : 0);
