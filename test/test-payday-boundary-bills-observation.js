'use strict';
/* Payday-boundary posted cash observation for canonical chequing-a.
 *
 * Atlas may preserve an observed posted balance for chequing-a when the
 * provider evidence household date equals a Seaspan payday. That packet is
 * posted-balance-observed-on-household-date: not payday-morning opening,
 * not pooled A+B, not leftover, and not Current Balance. Display names
 * are labels only. Missing evidence fails closed rather than $0.
 *
 * Independent reconstruction uses the synthetic observation inputs
 * (L-002). Live data.json cents are not the specification (L-006).
 *
 * `node test/test-payday-boundary-bills-observation.js`
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data.json');
const MAP = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'b81-account-map.json');
const IDENTITY = path.join(ROOT, 'docs', 'connectivity', 'transaction-identity.json');
const SNAPSHOT_DIR = path.join(ROOT, 'snapshots');

const PAYDAY = '2026-08-28';
const PAYDAY_AT = '2026-08-28T18:00:00.000Z';
const PAYDAY_CASH_AT = '2026-08-28T17:55:00.000Z';
const OPENING = '2026-08-19';
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
const POOLED = roundCent(BILLS + WEEKLY);
const ZERO = 0;
const DALE = 1800;

const liveData = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const accountMap = JSON.parse(fs.readFileSync(MAP, 'utf8'));
const identity = JSON.parse(fs.readFileSync(IDENTITY, 'utf8'));
const liveHash = hashFile(DATA);
const snapshotHashes = fs.readdirSync(SNAPSHOT_DIR)
  .filter(name => name.endsWith('.json'))
  .sort()
  .map(name => `${name}:${hashFile(path.join(SNAPSHOT_DIR, name))}`);

function filesUnchanged(label) {
  ok(hashFile(DATA) === liveHash, `${label}: data.json bytes unchanged`);
  const now = fs.readdirSync(SNAPSHOT_DIR)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => `${name}:${hashFile(path.join(SNAPSHOT_DIR, name))}`);
  ok(now.length === snapshotHashes.length
      && now.every((row, i) => row === snapshotHashes[i]),
    `${label}: snapshots unchanged`);
}

function fixturePlan(extra) {
  const opts = extra || {};
  return {
    defaults: { targetBuffer: 0 },
    startingCash: {
      amount: BILLS + WEEKLY + SAVINGS,
      breakdown: [
        {
          id: 'chequing-a',
          label: opts.billsLabel || 'BILLS ACCOUNT',
          value: opts.billsValue != null ? opts.billsValue : BILLS,
        },
        { id: 'chequing-b', label: 'WEEKLY SPENDING', value: WEEKLY },
        { id: 'savings', label: 'EMERGENCY SAVING', value: SAVINGS },
      ],
    },
    nextDollar: {
      policy: 'true-surplus-highest-interest',
      provenance: 'owner-stated',
    },
    opening: {
      asOf: opts.openingAsOf || OPENING,
      representedEvents: [],
      paydaySnapshot: opts.paydaySnapshot || undefined,
      paydayAccountObservations: opts.paydayAccountObservations || undefined,
      priorAsOf: opts.priorAsOf || undefined,
    },
    income: [
      {
        id: 'payroll', label: 'Dale income', frequency: 'biweekly',
        anchor: '2026-08-14', amount: DALE, confidence: 'confirmed',
      },
    ],
    bills: [],
    obligations: [],
    commitments: [],
    budget: { categories: [] },
  };
}

function observedCashPacket(rows, asOf) {
  const accounts = (rows || []).map(row => ({
    id: row.id,
    value: row.value,
    evidenceDate: row.evidenceDate,
  }));
  return {
    complete: accounts.some(row => row.id === 'chequing-a')
      && accounts.some(row => row.id === 'chequing-b'),
    asOf: asOf || PAYDAY,
    accounts,
  };
}

function recommend(plan, extra) {
  return F.recommend(plan, PAYDAY, Object.assign({
    targetBuffer: 0,
    debts: [{
      id: 'heloc', label: 'HELOC', secured: true, structure: 'Revolving',
      balance: 10000, rate: 5.45, payment: 50, pending: 0,
    }],
  }, extra || {}));
}

function operatingSnapshot(advice) {
  const view = advice && advice.defaultView || {};
  const alloc = advice && advice.paydayAllocation || {};
  const path = alloc.protectedPath || null;
  return {
    leftover: view.balanceAfterDeductions != null
      ? view.balanceAfterDeductions
      : view.predictedEndingBalance,
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

function independentCashRow(packet, accountId, paydayDate) {
  if (!packet || !accountId || !paydayDate) return null;
  if (packet.asOf && String(packet.asOf) !== String(paydayDate)) return null;
  const rows = Array.isArray(packet.accounts) ? packet.accounts : [];
  const row = rows.find(r => r && String(r.id) === String(accountId));
  if (!row) return null;
  if (String(row.evidenceDate) !== String(paydayDate)) return null;
  const value = Number(row.value);
  return Number.isFinite(value) ? roundCent(value) : null;
}

function independentCanonicalRow(plan, accountId, paydayDate) {
  if (!plan || !accountId || !paydayDate) return null;
  const opening = plan.opening;
  if (!opening || String(opening.asOf) !== String(paydayDate)) return null;
  if (opening.priorAsOf && opening.asOf === paydayDate && opening.priorAsOf < paydayDate) {
    return null;
  }
  const rows = (plan.startingCash && plan.startingCash.breakdown) || [];
  const row = rows.find(r => r && String(r.id) === String(accountId));
  if (!row) return null;
  const value = Number(row.value);
  return Number.isFinite(value) ? roundCent(value) : null;
}

function assertObservation(obs, expectedValue, source, label) {
  ok(!!obs, `${label}: packet is present`);
  if (!obs) return;
  ok(obs.accountId === 'chequing-a',
    `${label}: identity is canonical chequing-a`, obs.accountId);
  ok(near(obs.value, expectedValue),
    `${label}: preserves exact observed cents`, String(obs.value));
  ok(obs.evidenceDate === PAYDAY && obs.paydayDate === PAYDAY,
    `${label}: household evidence date is the payday`);
  ok(obs.temporalClaim === TEMPORAL,
    `${label}: temporal claim is posted-balance-observed-on-household-date`);
  ok(obs.isPaydayMorningOpening === false,
    `${label}: does not claim payday-morning opening`);
  ok(obs.isPooledChequing === false,
    `${label}: does not claim pooled A+B`);
  if (source) ok(obs.source === source, `${label}: source is ${source}`, obs.source);
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
  data.plan = Object.assign({}, data.plan, { startingCash: starting });
  return data;
}

function overlayFrom(data, extra) {
  const extraPayload = extra || {};
  return Live.fromObservation({
    data,
    payload: {
      provider: 'lunchmoney',
      fetchedAt: extraPayload.fetchedAt || PAYDAY_AT,
      source: 'Synthetic payday-boundary fixture. Not a live institution pull. Fixture IDs 3001–3010 are not live provider IDs.',
      pendingCoverage: extraPayload.pendingCoverage === undefined
        ? completePendingCoverage()
        : extraPayload.pendingCoverage,
      accounts: matchingAccounts(data, extraPayload.tweaks),
      transactions: extraPayload.transactions || [],
    },
    accountMap,
    identity,
  });
}

console.log('=== A. Canonical chequing-a identity; display names are labels ===');
{
  const plan = fixturePlan({ openingAsOf: PAYDAY });
  const renamed = fixturePlan({
    openingAsOf: PAYDAY,
    billsLabel: 'RENAMED PAYROLL CHEQUING 2026',
  });
  const obs = F.paydayBoundaryAccountObservation(plan, 'chequing-a', PAYDAY);
  const renamedObs = F.paydayBoundaryAccountObservation(renamed, 'chequing-a', PAYDAY);
  const byLabel = F.paydayBoundaryAccountObservation(plan, 'BILLS ACCOUNT', PAYDAY);
  const independent = independentCanonicalRow(plan, 'chequing-a', PAYDAY);
  ok(independent === BILLS, 'independent canonical chequing-a is the synthetic BILLS row');
  assertObservation(obs, BILLS, 'canonical-opening', 'payday-dated opening');
  assertObservation(renamedObs, BILLS, 'canonical-opening', 'renamed chequing-a');
  ok(obs && renamedObs && near(obs.value, renamedObs.value)
      && obs.accountId === renamedObs.accountId
      && obs.accountId === 'chequing-a',
    'rename produces identical canonical-id evidence');
  ok(byLabel == null,
    'display name BILLS ACCOUNT cannot substitute for canonical chequing-a');
}

console.log('=== B. Same-day provider observation preserves exact cents and date ===');
{
  const plan = fixturePlan();
  const packet = observedCashPacket([
    { id: 'chequing-a', value: LIVE_BILLS, evidenceDate: PAYDAY },
    { id: 'chequing-b', value: LIVE_WEEKLY, evidenceDate: PAYDAY },
    { id: 'savings', value: LIVE_SAVINGS, evidenceDate: PAYDAY },
  ], PAYDAY);
  const independent = independentCashRow(packet, 'chequing-a', PAYDAY);
  const obs = F.paydayBoundaryAccountObservation(plan, 'chequing-a', PAYDAY, {
    observedCash: packet,
  });
  ok(independent === LIVE_BILLS && independent !== BILLS,
    'independent live chequing-a is the synthetic observation, not opening cash');
  assertObservation(obs, LIVE_BILLS, 'provider-observation', 'same-day observedCash');
  const advice = recommend(plan, { observedCash: packet });
  const viewObs = advice.defaultView && advice.defaultView.paydayBoundaryBillsObservation;
  assertObservation(viewObs, LIVE_BILLS, 'provider-observation', 'defaultView');
}

console.log('=== C. chequing-b and pooled A+B cannot substitute ===');
{
  const plan = fixturePlan({
    paydaySnapshot: { periodStart: PAYDAY, asOf: PAYDAY, opening: POOLED },
  });
  const bOnly = observedCashPacket([
    { id: 'chequing-b', value: LIVE_WEEKLY, evidenceDate: PAYDAY },
  ], PAYDAY);
  const obsB = F.paydayBoundaryAccountObservation(plan, 'chequing-a', PAYDAY, {
    observedCash: bOnly,
  });
  const obsPooled = F.paydayBoundaryAccountObservation(plan, 'chequing-a', PAYDAY);
  const obsBAccount = F.paydayBoundaryAccountObservation(plan, 'chequing-b', PAYDAY, {
    observedCash: bOnly,
  });
  ok(obsB == null, 'chequing-b observed cash cannot substitute for chequing-a');
  ok(obsPooled == null,
    'pooled paydaySnapshot A+B cannot substitute for chequing-a');
  ok(obsBAccount && obsBAccount.accountId === 'chequing-b'
      && near(obsBAccount.value, LIVE_WEEKLY),
    'chequing-b lookup stays on chequing-b and does not leak into bills evidence');
  ok(independentCashRow(bOnly, 'chequing-a', PAYDAY) == null
      && POOLED === roundCent(BILLS + WEEKLY)
      && POOLED !== LIVE_BILLS,
    'independent reconstruction also withholds chequing-a and does not use A+B');
}

console.log('=== D. Missing fails closed; observed $0 is preserved; $0 is not invented ===');
{
  const plan = fixturePlan();
  const missing = F.paydayBoundaryAccountObservation(plan, 'chequing-a', PAYDAY);
  const emptyPacket = F.paydayBoundaryAccountObservation(plan, 'chequing-a', PAYDAY, {
    observedCash: observedCashPacket([], PAYDAY),
  });
  const zeroPlan = fixturePlan({ openingAsOf: PAYDAY, billsValue: ZERO });
  const zeroObs = F.paydayBoundaryAccountObservation(zeroPlan, 'chequing-a', PAYDAY);
  const zeroLive = F.paydayBoundaryAccountObservation(plan, 'chequing-a', PAYDAY, {
    observedCash: observedCashPacket([
      { id: 'chequing-a', value: ZERO, evidenceDate: PAYDAY },
    ], PAYDAY),
  });
  ok(missing == null && emptyPacket == null,
    'missing observation is unavailable, not $0');
  assertObservation(zeroObs, ZERO, 'canonical-opening', 'recorded $0 opening');
  assertObservation(zeroLive, ZERO, 'provider-observation', 'observed $0');
}

console.log('=== E. Stale evidence is not a fresh payday observation ===');
{
  const plan = fixturePlan();
  const staleDate = F.paydayBoundaryAccountObservation(plan, 'chequing-a', PAYDAY, {
    observedCash: observedCashPacket([
      { id: 'chequing-a', value: LIVE_BILLS, evidenceDate: '2026-08-27' },
    ], PAYDAY),
  });
  const staleAsOf = F.paydayBoundaryAccountObservation(plan, 'chequing-a', PAYDAY, {
    observedCash: observedCashPacket([
      { id: 'chequing-a', value: LIVE_BILLS, evidenceDate: PAYDAY },
    ], NEXT_DAY),
  });
  const wrongClaim = F.paydayBoundaryAccountObservation(plan, 'chequing-a', PAYDAY, {
    paydayAccountObservations: {
      periodStart: PAYDAY,
      asOf: PAYDAY,
      accounts: [{
        id: 'chequing-a',
        value: LIVE_BILLS,
        evidenceDate: PAYDAY,
        temporalClaim: 'payday-morning-opening',
        source: 'invented',
      }],
    },
  });
  ok(staleDate == null, 'previous-day evidenceDate is not a payday observation');
  ok(staleAsOf == null, 'next-day overlay asOf is not a payday observation');
  ok(wrongClaim == null, 'payday-morning-opening claim is refused');
}

console.log('=== F. Post-transaction live cash is not silently a pre-transaction opening ===');
{
  const advanced = fixturePlan({
    openingAsOf: PAYDAY,
    priorAsOf: OPENING,
    billsValue: LIVE_BILLS,
  });
  const obs = F.paydayBoundaryAccountObservation(advanced, 'chequing-a', PAYDAY);
  ok(obs == null,
    'live-advanced payday as-of does not treat later cash as a payday opening');
  const sameDayLive = F.paydayBoundaryAccountObservation(advanced, 'chequing-a', PAYDAY, {
    observedCash: observedCashPacket([
      { id: 'chequing-a', value: LIVE_BILLS, evidenceDate: PAYDAY },
    ], PAYDAY),
  });
  assertObservation(sameDayLive, LIVE_BILLS, 'provider-observation',
    'same-day live cash after transactions');
  ok(sameDayLive && sameDayLive.isPaydayMorningOpening === false
      && sameDayLive.temporalClaim === TEMPORAL,
    'same-day post-transaction observation is not labelled pre-transaction opening');
}

console.log('=== G. Historical payday is not manufactured from later cash ===');
{
  const plan = fixturePlan();
  const later = F.paydayBoundaryAccountObservation(plan, 'chequing-a', PAYDAY, {
    observedCash: observedCashPacket([
      { id: 'chequing-a', value: LIVE_BILLS, evidenceDate: NEXT_DAY },
    ], NEXT_DAY),
  });
  const walked = F.paydayBoundaryAccountObservation(plan, 'chequing-a', '2026-09-11');
  const currentMain = F.paydayBoundaryAccountObservation(liveData.plan, 'chequing-a', '2026-09-11');
  ok(later == null, 'later posted cash is not walked back into a payday observation');
  ok(walked == null, 'fixture opening.asOf 2026-08-19 is not a 2026-09-11 opening');
  ok(currentMain == null,
    'current canonical opening is not a 2026-09-11 chequing-a payday observation');
}

console.log('=== H. Leftover, Current Balance, and Prepare Ahead are unchanged ===');
{
  const plan = fixturePlan();
  const packet = observedCashPacket([
    { id: 'chequing-a', value: LIVE_BILLS, evidenceDate: PAYDAY },
    { id: 'chequing-b', value: LIVE_WEEKLY, evidenceDate: PAYDAY },
  ], PAYDAY);
  const without = recommend(plan);
  const withObs = recommend(plan, { observedCash: packet });
  const a = operatingSnapshot(without);
  const b = operatingSnapshot(withObs);
  ok(without.defaultView.paydayBoundaryBillsObservation == null,
    'without payday evidence the packet is unavailable');
  assertObservation(withObs.defaultView.paydayBoundaryBillsObservation, LIVE_BILLS,
    'provider-observation', 'recommend with observedCash');
  ok(snapshotsEqual(a, b),
    'leftover, Current Balance, and Prepare Ahead do not move when the packet is attached');
  const active = ((without.defaultView && without.defaultView.calendarPeriods) || [])
    .find(p => p && p.role === 'active') || null;
  const independentBad = active && active.incomeTotal != null && active.periodBillLoad != null
      && active.budgetHold != null
    ? roundCent(active.incomeTotal - active.periodBillLoad - active.budgetHold)
    : null;
  const publication = without.paydayAllocation
    && without.paydayAllocation.currentBalancePublication;
  const adjusted = roundCent(BILLS + DALE);
  ok(a.currentBalance == null
      && publication && publication.status === 'unavailable'
      && publication.source === 'pre-payday-bills-plus-planned-dale-payroll'
      && !near(a.currentBalance, adjusted)
      && !near(a.currentBalance, LIVE_BILLS)
      && !near(a.currentBalance, POOLED)
      && independentBad != null
      && near(a.leftover, independentBad)
      && (!near(a.leftover, LIVE_BILLS) || near(independentBad, LIVE_BILLS)),
    'an unproved pre-payday gap fails Current Balance closed; leftover stays income-led BAD');
}

console.log('=== I. Live overlay on payday retains chequing-a; rename-invariant; no writes ===');
{
  const canonical = syntheticCanonical();
  const result = overlayFrom(canonical, {
    fetchedAt: PAYDAY_AT,
    tweaks: {
      'chequing-a': LIVE_BILLS,
      'chequing-b': LIVE_WEEKLY,
      savings: LIVE_SAVINGS,
      cashAt: PAYDAY_CASH_AT,
      billsName: 'RENAMED PAYROLL CHEQUING 2026',
    },
  });
  ok(result.data.liveOverlay && result.data.liveOverlay.applied === true,
    'payday overlay applies with renamed chequing-a display name');
  const overlayCash = result.data.liveOverlay.observedCash;
  const independent = independentCashRow(overlayCash, 'chequing-a', PAYDAY);
  ok(independent === LIVE_BILLS, 'independent overlay observedCash chequing-a is synthetic live bills');
  const stamped = result.data.plan.opening && result.data.plan.opening.paydayAccountObservations;
  const stampedRow = stamped && Array.isArray(stamped.accounts)
    ? stamped.accounts.find(row => row && row.id === 'chequing-a')
    : null;
  ok(stamped && stamped.periodStart === PAYDAY && stamped.asOf === PAYDAY,
    'overlay retains paydayAccountObservations on the in-memory clone');
  ok(stampedRow && near(stampedRow.value, LIVE_BILLS)
      && stampedRow.evidenceDate === PAYDAY
      && stampedRow.temporalClaim === TEMPORAL
      && stampedRow.id === 'chequing-a',
    'retained row is canonical chequing-a at the exact observed cents');
  const forecastObs = F.paydayBoundaryAccountObservation(
    result.data.plan, 'chequing-a', PAYDAY);
  assertObservation(forecastObs, LIVE_BILLS, 'provider-observation', 'overlay clone');
  const pooledSnap = result.data.plan.opening.paydaySnapshot;
  ok(!pooledSnap || !near(forecastObs.value, pooledSnap.opening)
      || forecastObs.isPooledChequing === false,
    'account-specific observation is not the pooled paydaySnapshot figure');
  filesUnchanged('payday overlay retain');
}

console.log('=== J. Next-day overlay does not manufacture a payday opening ===');
{
  const canonical = syntheticCanonical();
  const result = overlayFrom(canonical, {
    fetchedAt: NEXT_DAY_AT,
    tweaks: {
      'chequing-a': LIVE_BILLS,
      'chequing-b': LIVE_WEEKLY,
      savings: LIVE_SAVINGS,
      cashAt: NEXT_DAY_CASH_AT,
    },
  });
  ok(result.data.liveOverlay && result.data.liveOverlay.applied === true,
    'next-day overlay applies');
  const stamped = result.data.plan.opening && result.data.plan.opening.paydayAccountObservations;
  const obs = F.paydayBoundaryAccountObservation(result.data.plan, 'chequing-a', PAYDAY, {
    observedCash: result.data.liveOverlay.observedCash,
  });
  ok(!stamped, 'next-day overlay does not retain a payday chequing-a observation');
  ok(obs == null, 'next-day posted chequing-a is not a 2026-08-28 payday observation');
  filesUnchanged('next-day overlay');
}

console.log('=== K. Stale cash overlay on payday fails closed for this packet ===');
{
  const canonical = syntheticCanonical();
  let threw = false;
  let result = null;
  try {
    result = overlayFrom(canonical, {
      fetchedAt: PAYDAY_AT,
      tweaks: {
        'chequing-a': LIVE_BILLS,
        'chequing-b': LIVE_WEEKLY,
        savings: LIVE_SAVINGS,
        cashAt: STALE_CASH_AT,
      },
    });
  } catch (err) {
    threw = true;
    result = err && err.data ? err : null;
  }
  const data = result && result.data ? result.data : result;
  const overlay = data && data.liveOverlay;
  const stamped = data && data.plan && data.plan.opening
    && data.plan.opening.paydayAccountObservations;
  const obs = data
    ? F.paydayBoundaryAccountObservation(data.plan, 'chequing-a', PAYDAY, {
      observedCash: overlay && overlay.observedCash,
    })
    : null;
  ok(threw || (overlay && overlay.applied === false),
    'stale payday cash does not apply a fresh overlay');
  ok(!stamped && obs == null,
    'stale previous-day cash is not retained as a payday observation');
  filesUnchanged('stale payday overlay');
}

console.log('=== L. Page does not calculate or reprint the observation ===');
{
  const planSrc = read('public/plan.js');
  const forecastSrc = read('public/forecast.js');
  ok(!/paydayBoundaryBillsObservation/.test(planSrc)
      && !/paydayBoundaryAccountObservation/.test(planSrc)
      && !/paydayAccountObservations/.test(planSrc),
    'plan.js does not reprint or calculate payday-boundary chequing-a evidence');
  ok(/posted-balance-observed-on-household-date/.test(forecastSrc)
      && /function paydayBoundaryAccountObservation\(/.test(forecastSrc)
      && /isPaydayMorningOpening: false/.test(forecastSrc)
      && /isPooledChequing: false/.test(forecastSrc)
      && /PAYDAY_BOUNDARY_BILLS_ACCOUNT_ID = 'chequing-a'/.test(forecastSrc),
    'Forecast owns the observation packet and canonical chequing-a identity');
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nAll payday-boundary chequing-a observation checks passed');
