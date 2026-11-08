'use strict';
/* Durable persist of payday-boundary chequing-a observation.
 *
 * Capture already works on the live overlay. Overlay retain is in-memory
 * and dies the next household day. T4 opening cutover would rewrite the
 * household opening and leftover / Current Balance / Prepare Ahead, so it
 * is the wrong persist. This suite proves the earned canonical-refresh
 * writer can store Forecast.paydayBoundaryAccountObservation on
 * plan.opening.paydayAccountObservations without advancing as-of.
 *
 * Independent reconstruction uses the synthetic observation inputs
 * (L-002). Live data.json cents are not the specification (L-006).
 *
 * `node test/test-payday-boundary-observation-persist.js`
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const C = require('../scripts/canonical-refresh.js');
const F = require('../public/forecast.js');
const Live = require('../scripts/live-plan.js');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;
const clone = x => JSON.parse(JSON.stringify(x));
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'canonical-refresh.js');
const LIVE_DATA = path.join(ROOT, 'data.json');
const MAP = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'b81-account-map.json');
const IDENTITY = path.join(ROOT, 'docs', 'connectivity', 'transaction-identity.json');
const SNAPSHOT_DIR = path.join(ROOT, 'snapshots');

const PAYDAY = '2026-08-28';
const PAYDAY_AT = '2026-08-28T18:00:00.000Z';
const PAYDAY_CASH_AT = '2026-08-28T17:55:00.000Z';
const EARLIER_PAYDAY = '2026-08-14';
const EARLIER_PAYDAY_AT = '2026-08-14T18:00:00.000Z';
const EARLIER_PAYDAY_CASH_AT = '2026-08-14T17:55:00.000Z';
const NEXT_DAY = '2026-08-29';
const NEXT_DAY_AT = '2026-08-29T18:00:00.000Z';
const NEXT_DAY_CASH_AT = '2026-08-29T17:55:00.000Z';
const STALE_CASH_AT = '2026-08-27T17:55:00.000Z';
const TEMPORAL = 'posted-balance-observed-on-household-date';

const BILLS = 412.07;
const WEEKLY = 88.41;
const SAVINGS = 15.55;
const LIVE_BILLS = 377.19;
const LIVE_WEEKLY = 64.02;
const LIVE_SAVINGS = 15.55;

const liveHash = hashFile(LIVE_DATA);
const liveData = JSON.parse(fs.readFileSync(LIVE_DATA, 'utf8'));
const accountMap = JSON.parse(fs.readFileSync(MAP, 'utf8'));
const identity = JSON.parse(fs.readFileSync(IDENTITY, 'utf8'));
const snapshotHashes = fs.readdirSync(SNAPSHOT_DIR)
  .filter(name => name.endsWith('.json'))
  .sort()
  .map(name => `${name}:${hashFile(path.join(SNAPSHOT_DIR, name))}`);

function filesUnchanged(label) {
  ok(hashFile(LIVE_DATA) === liveHash, `${label}: live data.json bytes unchanged`);
  const now = fs.readdirSync(SNAPSHOT_DIR)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => `${name}:${hashFile(path.join(SNAPSHOT_DIR, name))}`);
  ok(now.length === snapshotHashes.length
      && now.every((row, i) => row === snapshotHashes[i]),
    `${label}: snapshots unchanged`);
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-payday-obs-persist-'));
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

function cashValue(data, id) {
  const rows = ((data.plan && data.plan.startingCash && data.plan.startingCash.breakdown) || []);
  const row = rows.find(r => r && r.id === id);
  return row ? Number(row.value) : null;
}

function completePendingCoverage() {
  return {
    complete: true,
    basis: 'is_pending-unbounded',
    hasMore: false,
    startDate: null,
    endDate: null,
  };
}

function matchingAccounts(data, tweaks) {
  const t = tweaks || {};
  return [
    {
      id: 3001, name: t.billsName || 'BILLS ACCOUNT', type: 'cash', subtype: 'checking',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t['chequing-a'] != null ? t['chequing-a'] : cashValue(data, 'chequing-a'),
      updated_at: t.cashAt || PAYDAY_CASH_AT, balance_last_update: t.cashAt || PAYDAY_CASH_AT,
    },
    {
      id: 3002, name: 'WEEKLY SPENDING', type: 'cash', subtype: 'checking',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t['chequing-b'] != null ? t['chequing-b'] : cashValue(data, 'chequing-b'),
      updated_at: t.cashAt || PAYDAY_CASH_AT, balance_last_update: t.cashAt || PAYDAY_CASH_AT,
    },
    {
      id: 3003, name: 'EMERGENCY SAVING', type: 'cash', subtype: 'savings',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.savings != null ? t.savings : cashValue(data, 'savings'),
      updated_at: t.savingsAt || t.cashAt || PAYDAY_CASH_AT, balance_last_update: t.savingsAt || t.cashAt || PAYDAY_CASH_AT,
    },
    {
      id: 3004, name: 'PERSONAL CREDIT CARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.tdcc != null ? t.tdcc : (data.debts.find(d => d.id === 'tdcc') || {}).balance,
      credit_limit: (data.debts.find(d => d.id === 'tdcc') || {}).limit,
      updated_at: t.cardAt || PAYDAY_CASH_AT, balance_last_update: t.cardAt || PAYDAY_CASH_AT,
    },
    {
      id: 3005, name: 'TD CASH BACK VISA* CARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.cashback != null ? t.cashback : (data.debts.find(d => d.id === 'cashback') || {}).balance,
      credit_limit: (data.debts.find(d => d.id === 'cashback') || {}).limit,
      updated_at: t.cardAt || PAYDAY_CASH_AT, balance_last_update: t.cardAt || PAYDAY_CASH_AT,
    },
    {
      id: 3006, name: 'TRAVEL VISA', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.travelvisa != null ? t.travelvisa : (data.debts.find(d => d.id === 'travelvisa') || {}).balance,
      credit_limit: (data.debts.find(d => d.id === 'travelvisa') || {}).limit,
      updated_at: t.cardAt || PAYDAY_CASH_AT, balance_last_update: t.cardAt || PAYDAY_CASH_AT,
    },
    {
      id: 3007, name: 'LINE OF CREDIT - HOME EQUITY', type: 'loan', subtype: 'line_of_credit',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.heloc != null ? t.heloc : (data.debts.find(d => d.id === 'heloc') || {}).balance,
      updated_at: t.loanAt || PAYDAY_CASH_AT, balance_last_update: t.loanAt || PAYDAY_CASH_AT,
    },
    {
      id: 3008, name: 'MORTGAGE', type: 'loan', subtype: 'mortgage',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.mortgage != null ? t.mortgage : (data.debts.find(d => d.id === 'mortgage') || {}).balance,
      updated_at: t.loanAt || PAYDAY_CASH_AT, balance_last_update: t.loanAt || PAYDAY_CASH_AT,
    },
    {
      id: 3010, name: 'TRIANGLE MASTERCARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'Canadian Tire Bank', currency: 'cad',
      balance: t.triangle != null ? t.triangle : (data.debts.find(d => d.id === 'triangle') || {}).balance,
      credit_limit: (data.debts.find(d => d.id === 'triangle') || {}).limit,
      updated_at: t.triangleAt || PAYDAY_CASH_AT, balance_last_update: t.triangleAt || PAYDAY_CASH_AT,
    },
  ];
}

function syntheticCanonical() {
  const data = clone(liveData);
  const starting = clone(data.plan.startingCash);
  starting.amount = BILLS + WEEKLY + SAVINGS;
  starting.breakdown = (starting.breakdown || []).map(row => {
    if (!row) return row;
    if (row.id === 'chequing-a') return Object.assign({}, row, { value: BILLS, label: 'BILLS ACCOUNT' });
    if (row.id === 'chequing-b') return Object.assign({}, row, { value: WEEKLY });
    if (row.id === 'savings') return Object.assign({}, row, { value: SAVINGS });
    return row;
  });
  data.plan = Object.assign({}, data.plan, {
    startingCash: starting,
    opening: Object.assign({}, data.plan.opening, {
      paydayAccountObservations: undefined,
    }),
  });
  delete data.plan.opening.paydayAccountObservations;
  return data;
}

function paydayPayload(data, extra) {
  const extraPayload = extra || {};
  return {
    provider: 'lunchmoney',
    fetchedAt: extraPayload.fetchedAt || PAYDAY_AT,
    source: 'Synthetic payday-observation persist fixture. Not a live institution pull. Fixture IDs 3001–3010 are not live provider IDs.',
    pendingCoverage: extraPayload.pendingCoverage === undefined
      ? completePendingCoverage()
      : extraPayload.pendingCoverage,
    accounts: matchingAccounts(data, extraPayload.tweaks),
    transactions: extraPayload.transactions || [],
  };
}

function previewPayday(data, extra) {
  const payload = paydayPayload(data, extra);
  return C.previewFrom({
    provider: 'lunchmoney',
    payload,
    accountMap,
    data,
    identity,
    fetchedAt: payload.fetchedAt,
  }, { preservePaydayObservation: true });
}

function recommend(plan) {
  return F.recommend(plan, PAYDAY, {
    targetBuffer: 0,
    debts: plan && liveData.debts ? liveData.debts : [],
  });
}

function operatingSnapshot(advice) {
  const view = advice && advice.defaultView || {};
  const alloc = advice && advice.paydayAllocation || {};
  const path = alloc.protectedPath || null;
  return {
    leftover: view.afterHouseholdBudget,
    currentBalance: view.liveCurrentBalance,
    afterBills: view.afterBills,
    prepareAheadWanted: path && path.wanted,
    prepareAheadAllocated: path && path.allocated,
    extraDebt: alloc.extraDebt && alloc.extraDebt.allocated,
  };
}

function snapshotsEqual(a, b) {
  return near(a.leftover, b.leftover)
    && near(a.currentBalance, b.currentBalance)
    && near(a.afterBills, b.afterBills)
    && JSON.stringify(a.prepareAheadWanted) === JSON.stringify(b.prepareAheadWanted)
    && JSON.stringify(a.prepareAheadAllocated) === JSON.stringify(b.prepareAheadAllocated)
    && JSON.stringify(a.extraDebt) === JSON.stringify(b.extraDebt);
}

function overlayFrom(data, extra) {
  const extraPayload = extra || {};
  return Live.fromObservation({
    data,
    payload: paydayPayload(data, extraPayload),
    accountMap,
    identity,
  });
}

console.log('=== A. Payday same-day chequing-a observation is proposable ===');
{
  const data = syntheticCanonical();
  const { preview } = previewPayday(data, {
    tweaks: {
      'chequing-a': LIVE_BILLS,
      'chequing-b': LIVE_WEEKLY,
      savings: LIVE_SAVINGS,
      cashAt: PAYDAY_CASH_AT,
    },
  });
  const proposal = preview.paydayAccountObservation;
  ok(proposal && proposal.paydayObservationWriteSupported === true,
    'same-day payday observation is proposable');
  ok(proposal && proposal.paydayObservationApprovalId,
    'proposal carries a distinct paydayObservationApprovalId');
  const row = proposal && proposal.packet && proposal.packet.accounts
    && proposal.packet.accounts[0];
  ok(row && row.id === 'chequing-a' && near(row.value, LIVE_BILLS),
    'proposal preserves independent fixture chequing-a cents',
    row && String(row.value));
  ok(row && row.evidenceDate === PAYDAY && proposal.packet.periodStart === PAYDAY,
    'proposal household date is the Seaspan payday');
  ok(row && row.temporalClaim === TEMPORAL
      && proposal.isPaydayMorningOpening === false
      && proposal.isPooledChequing === false,
    'proposal is posted-balance-observed-on-household-date, not morning opening or pooled A+B');
  ok(String(proposal.currentOpeningAsOf) === String(data.plan.opening.asOf),
    'proposal does not treat persist as an opening cutover');
  ok(proposal.paydayObservationApprovalId !== preview.previewId,
    'paydayObservationApprovalId is distinct from posted previewId');
  filesUnchanged('payday proposal');
}

console.log('=== B. Display names are labels; wrong account / stale / next-day fail closed ===');
{
  const data = syntheticCanonical();
  const renamed = previewPayday(data, {
    tweaks: {
      'chequing-a': LIVE_BILLS,
      'chequing-b': LIVE_WEEKLY,
      savings: LIVE_SAVINGS,
      cashAt: PAYDAY_CASH_AT,
      billsName: 'RENAMED PAYROLL CHEQUING 2026',
    },
  }).preview.paydayAccountObservation;
  ok(renamed && renamed.paydayObservationWriteSupported === true
      && near(renamed.packet.accounts[0].value, LIVE_BILLS)
      && renamed.packet.accounts[0].id === 'chequing-a',
    'renamed Lunch Money display name still proposes canonical chequing-a');

  const stale = previewPayday(data, {
    fetchedAt: PAYDAY_AT,
    tweaks: {
      'chequing-a': LIVE_BILLS,
      'chequing-b': LIVE_WEEKLY,
      savings: LIVE_SAVINGS,
      cashAt: STALE_CASH_AT,
    },
  }).preview.paydayAccountObservation;
  ok(stale && stale.paydayObservationWriteSupported === false
      && stale.packet == null,
    'stale previous-day cash is not a payday observation persist');

  const nextDay = previewPayday(data, {
    fetchedAt: NEXT_DAY_AT,
    tweaks: {
      'chequing-a': LIVE_BILLS,
      'chequing-b': LIVE_WEEKLY,
      savings: LIVE_SAVINGS,
      cashAt: NEXT_DAY_CASH_AT,
    },
  }).preview.paydayAccountObservation;
  ok(nextDay && nextDay.paydayObservationWriteSupported === false
      && nextDay.packet == null,
    'next-day posted cash is not a 2026-08-28 payday persist');
}

console.log('=== C. Apply writes only the packet; leftover / Current Balance / Prepare Ahead unchanged ===');
{
  const dir = tempDir();
  const data = syntheticCanonical();
  const beforeAdvice = recommend(data.plan);
  const beforeSnap = operatingSnapshot(beforeAdvice);
  const dataPath = writeJson(dir, 'data.json', data);
  const fixturePath = writeJson(dir, 'fixture.json', paydayPayload(data, {
    tweaks: {
      'chequing-a': LIVE_BILLS,
      'chequing-b': LIVE_WEEKLY,
      savings: LIVE_SAVINGS,
      cashAt: PAYDAY_CASH_AT,
    },
  }));
  const previewRun = runCli([
    '--fixture', fixturePath,
    '--map', MAP,
    '--identity', IDENTITY,
    '--data', dataPath,
    '--preserve-payday-observation',
  ]);
  ok(previewRun.code === 0, 'persist preview exits 0');
  const preview = JSON.parse(previewRun.stdout);
  const approval = preview.paydayAccountObservation
    && preview.paydayAccountObservation.paydayObservationApprovalId;
  ok(!!approval, 'preview stdout includes paydayObservationApprovalId');

  const refusedPosted = runCli([
    '--fixture', fixturePath,
    '--map', MAP,
    '--identity', IDENTITY,
    '--data', dataPath,
    '--preserve-payday-observation',
    '--apply',
    '--approve', preview.previewId,
  ]);
  ok(refusedPosted.code !== 0
      && /previewId cannot authorize a payday observation persist/.test(refusedPosted.stderr),
    'posted previewId cannot authorize payday observation persist');

  const refusedCutover = runCli([
    '--fixture', fixturePath,
    '--map', MAP,
    '--identity', IDENTITY,
    '--data', dataPath,
    '--preserve-payday-observation',
    '--cutover-as-of', PAYDAY,
  ]);
  ok(refusedCutover.code !== 0
      && /cannot combine with --cutover-as-of/.test(refusedCutover.stderr),
    'T4 --cutover-as-of cannot be combined with payday observation persist');

  const applied = runCli([
    '--fixture', fixturePath,
    '--map', MAP,
    '--identity', IDENTITY,
    '--data', dataPath,
    '--preserve-payday-observation',
    '--apply',
    '--approve-payday-observation', approval,
  ]);
  ok(applied.code === 0, 'approved persist exits 0', applied.stderr);
  const result = applied.code === 0 ? JSON.parse(applied.stdout) : {};
  ok(result.writesCanonicalState === true && result.writesOpening === false
      && result.writesSnapshot === false,
    'persist writes canonical packet and does not advance opening or snapshots');
  const written = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const packet = written.plan.opening.paydayAccountObservations;
  const row = packet && packet.accounts && packet.accounts[0];
  ok(packet && packet.periodStart === PAYDAY && packet.asOf === PAYDAY,
    'written packet is the payday slot');
  ok(row && row.id === 'chequing-a' && near(row.value, LIVE_BILLS)
      && row.evidenceDate === PAYDAY && row.temporalClaim === TEMPORAL,
    'written row is independent fixture chequing-a cents');
  ok(String(written.plan.opening.asOf) === String(data.plan.opening.asOf)
      && String(written.meta.asOf) === String(data.meta.asOf),
    'opening as-of is unchanged');
  ok(near(cashValue(written, 'chequing-a'), BILLS)
      && near(cashValue(written, 'chequing-b'), WEEKLY)
      && near(cashValue(written, 'savings'), SAVINGS),
    'startingCash breakdown is unchanged');
  const afterSnap = operatingSnapshot(recommend(written.plan));
  ok(snapshotsEqual(beforeSnap, afterSnap),
    'leftover, Current Balance, and Prepare Ahead are unchanged');
  const persisted = F.paydayBoundaryAccountObservation(
    written.plan, 'chequing-a', PAYDAY);
  ok(persisted && near(persisted.value, LIVE_BILLS)
      && persisted.temporalClaim === TEMPORAL
      && persisted.isPaydayMorningOpening === false,
    'Forecast reads the persisted chequing-a observation');
  filesUnchanged('approved persist uses temp data');
}

console.log('=== A12. owner edit during the provider fetch is never overwritten (payday observation) ===');
{
  const { runWithConcurrentOwnerEdit } = require('./refresh-concurrent-edit-preload.js');
  const dir = tempDir();
  const data = syntheticCanonical();
  const dataPath = writeJson(dir, 'data.json', data);
  const fixturePath = writeJson(dir, 'fixture.json', paydayPayload(data, {
    tweaks: {
      'chequing-a': LIVE_BILLS,
      'chequing-b': LIVE_WEEKLY,
      savings: LIVE_SAVINGS,
      cashAt: PAYDAY_CASH_AT,
    },
  }));
  const previewRun = runCli([
    '--fixture', fixturePath, '--map', MAP, '--identity', IDENTITY,
    '--data', dataPath, '--preserve-payday-observation',
  ]);
  const approval = previewRun.code === 0
    ? JSON.parse(previewRun.stdout).paydayAccountObservation.paydayObservationApprovalId
    : null;
  ok(!!approval, 'payday: preview produced an approval to race against');
  const res = runWithConcurrentOwnerEdit([
    '--fixture', fixturePath, '--map', MAP, '--identity', IDENTITY,
    '--data', dataPath, '--preserve-payday-observation',
    '--apply', '--approve-payday-observation', approval,
  ], fixturePath, dataPath);
  ok(res.code !== 0, 'payday: apply refuses when data.json changed during the fetch', res.stderr.trim());
  ok(res.refusedAsChanged, 'payday: refusal names the changed canonical file (compare-and-swap)');
  ok(res.ownerEditSurvived, 'payday: the invented owner instruction and $200 bill survive on disk');
  ok(!(res.after.plan.opening && res.after.plan.opening.paydayAccountObservations),
    'payday: the approved packet was not merged into the edited file');
  filesUnchanged('concurrent-edit refusal uses temp data');
}

console.log('=== D. Next-day overlay keeps the persisted payday packet and does not overwrite it ===');
{
  const dir = tempDir();
  const data = syntheticCanonical();
  const dataPath = writeJson(dir, 'data.json', data);
  const fixturePath = writeJson(dir, 'fixture.json', paydayPayload(data, {
    tweaks: {
      'chequing-a': LIVE_BILLS,
      'chequing-b': LIVE_WEEKLY,
      savings: LIVE_SAVINGS,
      cashAt: PAYDAY_CASH_AT,
    },
  }));
  const preview = JSON.parse(runCli([
    '--fixture', fixturePath,
    '--map', MAP,
    '--identity', IDENTITY,
    '--data', dataPath,
    '--preserve-payday-observation',
  ]).stdout);
  const applied = runCli([
    '--fixture', fixturePath,
    '--map', MAP,
    '--identity', IDENTITY,
    '--data', dataPath,
    '--preserve-payday-observation',
    '--apply',
    '--approve-payday-observation',
    preview.paydayAccountObservation.paydayObservationApprovalId,
  ]);
  ok(applied.code === 0, 'persist for overlay proof exits 0');
  const written = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const nextDay = overlayFrom(written, {
    fetchedAt: NEXT_DAY_AT,
    tweaks: {
      'chequing-a': 12.34,
      'chequing-b': LIVE_WEEKLY,
      savings: LIVE_SAVINGS,
      cashAt: NEXT_DAY_CASH_AT,
    },
  });
  const stamped = nextDay.data.plan.opening && nextDay.data.plan.opening.paydayAccountObservations;
  const obs = F.paydayBoundaryAccountObservation(
    nextDay.data.plan, 'chequing-a', PAYDAY, {
      observedCash: nextDay.data.liveOverlay && nextDay.data.liveOverlay.observedCash,
    });
  ok(stamped && stamped.periodStart === PAYDAY && stamped.asOf === PAYDAY,
    'next-day overlay retains the persisted payday packet');
  ok(obs && near(obs.value, LIVE_BILLS) && obs.evidenceDate === PAYDAY,
    'next-day live cash does not replace the persisted payday observation');
  ok(!near(obs.value, 12.34),
    'later posted chequing-a is not walked backward into the payday packet');
  filesUnchanged('next-day overlay retain');
}

console.log('=== E. Existing different-payday packet is protected; $0 observation is preserved ===');
{
  const data = syntheticCanonical();
  data.plan.opening.paydayAccountObservations = {
    periodStart: '2026-08-14',
    asOf: '2026-08-14',
    accounts: [{
      id: 'chequing-a',
      value: 99.01,
      evidenceDate: '2026-08-14',
      temporalClaim: TEMPORAL,
      source: 'provider-observation',
    }],
  };
  const protectedProposal = previewPayday(data, {
    tweaks: {
      'chequing-a': LIVE_BILLS,
      'chequing-b': LIVE_WEEKLY,
      savings: LIVE_SAVINGS,
      cashAt: PAYDAY_CASH_AT,
    },
  }).preview.paydayAccountObservation;
  ok(protectedProposal && protectedProposal.paydayObservationWriteSupported === false
      && protectedProposal.reason === 'existing-payday-observation-protected',
    'a recorded packet for a different payday is not overwritten');

  const zeroData = syntheticCanonical();
  const zeroProposal = previewPayday(zeroData, {
    tweaks: {
      'chequing-a': 0,
      'chequing-b': LIVE_WEEKLY,
      savings: LIVE_SAVINGS,
      cashAt: PAYDAY_CASH_AT,
    },
  }).preview.paydayAccountObservation;
  ok(zeroProposal && zeroProposal.paydayObservationWriteSupported === true
      && near(zeroProposal.packet.accounts[0].value, 0),
    'an actually observed $0 is preserved, not treated as unavailable');
}

console.log('=== F. Page does not calculate persist; Forecast remains authority ===');
{
  const planSrc = read('public/plan.js');
  const refreshSrc = read('scripts/canonical-refresh.js');
  ok(!/paydayAccountObservations/.test(planSrc)
      && !/approve-payday-observation/.test(planSrc),
    'plan.js does not persist or reprint paydayAccountObservations');
  ok(/PAYDAY_OBSERVATION_SCHEMA = 'atlas-payday-account-observation-approval\/v1'/.test(refreshSrc)
      && /--preserve-payday-observation/.test(refreshSrc)
      && /existing-payday-observation-protected/.test(refreshSrc)
      && /paydayEvidenceIsCanonicalNewer/.test(refreshSrc)
      && /Payday observation evidence predates the current canonical opening/.test(refreshSrc),
    'canonical-refresh owns the bounded persist approval and older-than-opening fail-closed');
}

console.log('=== G. Earlier-payday / canonical-newer evidence cannot mint an approval or write ===');
{
  const data = syntheticCanonical();
  ok(String(data.plan.opening.asOf) === '2026-08-19',
    'fixture canonical opening remains 2026-08-19');
  const earlierPayload = paydayPayload(data, {
    fetchedAt: EARLIER_PAYDAY_AT,
    tweaks: {
      'chequing-a': LIVE_BILLS,
      'chequing-b': LIVE_WEEKLY,
      savings: LIVE_SAVINGS,
      cashAt: EARLIER_PAYDAY_CASH_AT,
    },
  });
  const earlierRun = C.previewFrom({
    provider: 'lunchmoney',
    payload: earlierPayload,
    accountMap,
    data,
    identity,
    fetchedAt: earlierPayload.fetchedAt,
  }, { preservePaydayObservation: true });
  const earlierProposal = earlierRun.preview.paydayAccountObservation;
  const billsRow = ((earlierRun.report.reconciliation && earlierRun.report.reconciliation.rows) || [])
    .find(row => row && row.canonicalTarget === 'cash:chequing-a');
  ok(billsRow && billsRow.dateRelation === 'canonical-newer'
      && String(billsRow.evidenceDate) === EARLIER_PAYDAY,
    'reconciler marks earlier-payday chequing-a as canonical-newer');
  ok(earlierProposal
      && earlierProposal.paydayObservationWriteSupported === false
      && earlierProposal.paydayObservationApprovalId == null
      && earlierProposal.packet == null
      && earlierProposal.reason === 'stale-not-current',
    'canonical-newer payday evidence cannot mint an approval ID');

  const dir = tempDir();
  const dataPath = writeJson(dir, 'data.json', data);
  const fixturePath = writeJson(dir, 'fixture.json', earlierPayload);
  const beforeHash = hashFile(dataPath);
  const applied = runCli([
    '--fixture', fixturePath,
    '--map', MAP,
    '--identity', IDENTITY,
    '--data', dataPath,
    '--preserve-payday-observation',
    '--apply',
    '--approve-payday-observation',
    'deadbeef',
  ]);
  ok(applied.code !== 0
      && /No payday observation proposal exists to approve/.test(applied.stderr),
    'canonical-newer evidence cannot write even with a caller-supplied approval token');
  const afterCli = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  ok(hashFile(dataPath) === beforeHash && !afterCli.plan.opening.paydayAccountObservations,
    'canonical document was not written from earlier-payday evidence');

  const forgedPath = writeJson(dir, 'forged-data.json', data);
  const forgedBefore = hashFile(forgedPath);
  let applyThrew = false;
  let applyMessage = '';
  try {
    C.applyPaydayObservationPreview(data, {
      paydayAccountObservation: {
        schema: 'atlas-payday-account-observation-approval/v1',
        writesCanonicalState: false,
        paydayObservationWriteSupported: true,
        paydayObservationApprovalId: 'forged-earlier-payday',
        packet: {
          periodStart: EARLIER_PAYDAY,
          asOf: EARLIER_PAYDAY,
          accounts: [{
            id: 'chequing-a',
            value: LIVE_BILLS,
            evidenceDate: EARLIER_PAYDAY,
            temporalClaim: TEMPORAL,
            source: 'provider-observation',
          }],
        },
        currentOpeningAsOf: data.plan.opening.asOf,
        paydayDate: EARLIER_PAYDAY,
      },
    }, forgedPath);
  } catch (err) {
    applyThrew = true;
    applyMessage = String(err && err.message || err);
  }
  ok(applyThrew
      && /predates the current canonical opening/.test(applyMessage),
    'apply fail-closes a forged earlier-payday packet');
  ok(hashFile(forgedPath) === forgedBefore,
    'forged earlier-payday apply did not write');

  const advanced = syntheticCanonical();
  advanced.meta.asOf = NEXT_DAY;
  advanced.plan.opening.asOf = NEXT_DAY;
  const afterPaydayRun = previewPayday(advanced, {
    fetchedAt: PAYDAY_AT,
    tweaks: {
      'chequing-a': LIVE_BILLS,
      'chequing-b': LIVE_WEEKLY,
      savings: LIVE_SAVINGS,
      cashAt: PAYDAY_CASH_AT,
    },
  });
  const afterPayday = afterPaydayRun.preview.paydayAccountObservation;
  const advancedRow = ((afterPaydayRun.report.reconciliation
    && afterPaydayRun.report.reconciliation.rows) || [])
    .find(row => row && row.canonicalTarget === 'cash:chequing-a');
  ok(advancedRow && advancedRow.dateRelation === 'canonical-newer',
    'payday evidence against an advanced opening is canonical-newer');
  ok(afterPayday
      && afterPayday.paydayObservationWriteSupported === false
      && afterPayday.paydayObservationApprovalId == null
      && afterPayday.packet == null
      && afterPayday.reason === 'stale-not-current',
    'payday evidence that predates an advanced opening cannot mint an approval ID');
  filesUnchanged('earlier-payday / canonical-newer reject');
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nAll payday-boundary observation persist checks passed');
