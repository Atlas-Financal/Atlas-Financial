'use strict';
// A1: a future-dated or undated balance never becomes current, precise cash.
// Independent invented ledger: today's Bills cash is 100; the provider reports
// 200 dated tomorrow. Expected values below are written by hand, not computed
// by the code under test.
const assert = require('node:assert/strict');
const path = require('node:path');
const root = process.env.ATLAS_TEST_APP_ROOT || path.join(__dirname, '..');
const O = require(path.join(root, 'scripts/provider-observe'));
const R = require(path.join(root, 'scripts/reconcile'));
const Live = require(path.join(root, 'scripts/live-plan'));
const F = require(path.join(root, 'public/forecast'));
const base = require('./fixtures/card-backfill-data');
const savingsData = require('./fixtures/savings-daily-consumer-data');

let checks = 0;
function eq(a, b, why) { assert.deepEqual(a, b, why); checks++; }
function yes(v, why) { assert.ok(v, why); checks++; }

const TODAY = '2026-09-20';
const TOMORROW = '2026-09-21';
const YESTERDAY = '2026-09-19';

// Cash-only invented world: Bills 100, spending 0, savings 0, no cards,
// no income, no bills, no budget. Opening is dated today (same-day refresh).
function world(balanceDate, opts = {}) {
  const x = base('invented-card', 'invented-min');
  x.data.meta.asOf = x.data.plan.opening.asOf = opts.openingAsOf || TODAY;
  x.data.plan.startingCash.breakdown[0].value = 100;
  x.data.plan.obligations = [];
  x.data.plan.budget.categories = [];
  x.data.plan.income[0].amount = 0;
  x.data.debts = [];
  x.accountMap.mappings = x.accountMap.mappings.slice(0, 3);
  x.payload.accounts = x.payload.accounts.slice(0, 3);
  x.payload.transactions = [];
  const bills = x.payload.accounts[0];
  bills.balance = 200;
  if (balanceDate === null) delete bills.balance_last_update;
  else bills.balance_last_update = balanceDate + 'T17:00:00Z';
  return x;
}

function billsCash(data) {
  return data.plan.startingCash.breakdown.find(row => row.id === 'chequing-a').value;
}

// ── Control: a balance dated today is current and overlays. ──
{
  const x = world(TODAY);
  const live = Live.fromObservation(x);
  eq(billsCash(live.data), 200, 'control: today-dated 200 overlays today\'s 100');
  eq(live.overlays.some(row => row.locator === 'cash:chequing-a'), true, 'control: overlay proposed');
  eq(live.data.refreshTrust.displayState, 'current', 'control: a dated, same-day balance is current');
}

for (const [label, date] of [['future-dated', TOMORROW], ['undated', null]]) {
  const x = world(date);
  const before = JSON.stringify(x);

  // Observer: the balance is unknown.
  const report = O.observe({ provider: 'lunchmoney', ...x });
  const obs = report.observations.find(row => row.observationId === 'lm-3001-cash');
  eq(obs.unknown, true, label + ': observer marks the balance unknown');
  const balanceCoverage = report.observationReceipt.balanceCoverage;
  eq(balanceCoverage.status, 'incomplete', label + ': observer receipt balance coverage is incomplete');
  eq(balanceCoverage.requiredCashMissingDatedBalance.includes('chequing-a'), true,
    label + ': observer receipt does not count it as dated required cash');

  // Generic reconciliation keeps the unknown flag and never makes a CHANGE.
  const row = report.reconciliation.rows.find(r => r.canonicalTarget === 'cash:chequing-a');
  eq(row.unknown, true, label + ': reconciliation keeps unknown provenance');
  eq(row.status, 'MISSING', label + ': unknown is MISSING, never CHANGE or MATCH');
  eq(row.evidenceValue, null, label + ': unknown carries no value');
  eq(row.difference, null, label + ': unknown carries no difference');

  // Live overlay: today's 100 is kept; nothing is proposed for Bills.
  const live = Live.fromObservation(x);
  eq(billsCash(live.data), 100, label + ': dated 100 is kept; 200 never replaces it');
  eq(F.startingCashAmount(live.data.plan), 100, label + ': Forecast opening is 100 + 0 + 0');
  eq(live.overlays.some(r => r.locator === 'cash:chequing-a'), false, label + ': no cash overlay');
  yes(live.refused.some(r => r.locator === 'cash:chequing-a'), label + ': cash row refused');

  // Refresh trust: never "current", never a waiting canonical proposal.
  const trust = live.data.refreshTrust;
  yes(trust.displayState !== 'current', label + ': display is not current (' + trust.displayState + ')');
  eq(trust.canonicalProposalCount, 0, label + ': no canonical proposal for an unknown balance');
  yes(trust.coverageLimits.some(l => l.id === 'required-cash-balance-unproven'),
    label + ': required cash balance is unproven');
  eq(JSON.stringify(x), before, label + ': inputs unchanged');

  // Repeat refresh on the overlaid result cannot promote it.
  const replay = Live.fromObservation({ ...world(date), data: live.data });
  eq(billsCash(replay.data), 100, label + ': repeat refresh still keeps 100');
}

// ── A stale (yesterday) balance never replaces today's cash either. ──
{
  const live = Live.fromObservation(world(YESTERDAY));
  eq(billsCash(live.data), 100, 'stale: yesterday\'s 200 never replaces today\'s 100');
  eq(live.overlays.some(r => r.locator === 'cash:chequing-a'), false, 'stale: no cash overlay');
}

// ── An as-of advance with a future-dated balance still fails closed. ──
{
  const x = world(TOMORROW, { openingAsOf: YESTERDAY });
  let threw = null;
  let live = null;
  try { live = Live.fromObservation(x); } catch (e) { threw = e; }
  yes(threw || (live && billsCash(live.data) === 100),
    'advance: a future-dated balance cannot become the advanced opening');
}

// ── Same-day refresh: a debt balance dated tomorrow is refused even though
// the observer does not mark generic loan dates unknown. Mortgage 5000 today;
// provider reports 4000 dated tomorrow. ──
{
  const x = world(TODAY);
  x.payload.accounts[0].balance = 100;
  x.data.debts = [{ id: 'mortgage', label: 'Invented mortgage', structure: 'Amortizing',
    secured: true, balance: 5000, rate: 0 }];
  x.accountMap.mappings.push({ providerAccountId: '3009',
    canonical: { collection: 'debts', id: 'mortgage' }, atlasRole: 'mortgage' });
  x.payload.accounts.push({ id: 3009, name: 'Invented mortgage', type: 'loan', subtype: 'mortgage',
    institution_name: 'Invented', currency: 'cad', balance: 4000,
    updated_at: TOMORROW + 'T17:00:00Z', balance_as_of: TOMORROW + 'T17:00:00Z' });
  const live = Live.fromObservation(x);
  eq(live.data.debts[0].balance, 5000, 'future debt: today\'s 5000 is kept; 4000 never replaces it');
  eq(live.overlays.some(r => r.locator === 'debts:mortgage'), false, 'future debt: no overlay');
  eq(live.refused.find(r => r.locator === 'debts:mortgage').reason, 'future-not-current',
    'future debt: refused as future, not current');
  const same = world(TODAY);
  same.payload.accounts[0].balance = 100;
  same.data.debts = x.data.debts;
  same.accountMap.mappings = x.accountMap.mappings;
  same.payload.accounts = x.payload.accounts.map(a => a.id === 3009
    ? { ...a, updated_at: TODAY + 'T17:00:00Z', balance_as_of: TODAY + 'T17:00:00Z' } : a);
  eq(Live.fromObservation(same).data.debts[0].balance, 4000, 'control debt: today-dated 4000 overlays');
}

// ── Reconcile directly: unknown never counts, mixed unknown/known conflicts. ──
{
  const data = { meta: { asOf: TODAY }, debts: [],
    plan: { startingCash: { breakdown: [{ id: 'chequing-a', value: 100 }] } } };
  const canonical = { collection: 'cash', id: 'chequing-a' };
  const unknownObs = { observationId: 'u', canonical, evidenceValue: 200,
    evidenceDate: TOMORROW, unknown: true, unknownReason: 'balance-date-after-request' };
  const knownObs = { observationId: 'k', canonical, evidenceValue: 200, evidenceDate: TODAY };
  const only = R.reconcile({ data, observations: [unknownObs] }).rows;
  eq(only.map(r => [r.status, r.unknown, r.evidenceValue, r.unknownReason]),
    [['MISSING', true, null, 'balance-date-after-request']], 'reconcile: lone unknown is MISSING');
  const mixed = R.reconcile({ data, observations: [unknownObs, knownObs] }).rows;
  eq(mixed.map(r => r.status), ['CONFLICT', 'CONFLICT'], 'reconcile: unknown beside known conflicts');
  const known = R.reconcile({ data, observations: [knownObs] }).rows;
  eq(known.map(r => [r.status, r.evidenceValue, r.unknown]), [['CHANGE', 200, undefined]],
    'reconcile: a known dated 200 against 100 is still a CHANGE');
}

// ── Savings inventory: a future-dated pool observation never self-certifies. ──
{
  const data = savingsData('ready');
  const day = data.meta.asOf; // 2026-10-05 in the invented fixture
  eq(day, '2026-10-05', 'savings: invented fixture day');
  const plan = JSON.parse(JSON.stringify(data.plan));
  const accounts = plan.savingsPoolObservation.accounts;
  const at = date => ({ asOf: date, accounts: accounts.map(r => ({ ...r, evidenceDate: date })) });

  plan.savingsPoolObservation = at(day);
  const current = F.savingsInventory(plan, day).pools;
  eq(current.map(p => [p.observedTrust, p.observedCash]), [['verified', 95], ['verified', 24]],
    'savings: a same-day observation is verified');

  plan.savingsPoolObservation = at('2026-10-06');
  const future = F.savingsInventory(plan, day).pools;
  eq(future.map(p => [p.status, p.observedTrust, p.observedCash]),
    [['cash-unknown', 'unknown', null], ['cash-unknown', 'unknown', null]],
    'savings: a future-dated observation is unknown, never verified');

  plan.savingsPoolObservation = { asOf: day, accounts: accounts.map(r => ({ ...r, evidenceDate: '2026-10-06' })) };
  const futureBalance = F.savingsInventory(plan, day).pools;
  eq(futureBalance.map(p => p.observedTrust), ['unknown', 'unknown'],
    'savings: a future-dated balance inside a current observation is unknown');

  plan.savingsPoolObservation = at('2026-10-04');
  const stale = F.savingsInventory(plan, day).pools;
  eq(stale.map(p => [p.status, p.observedTrust]), [['stale', 'unknown'], ['stale', 'unknown']],
    'savings: a prior-day observation is stale');
}

console.log('PASS future-dated or undated balances stay unknown through observe -> reconcile -> live overlay -> refresh trust, and savings inventory: '
  + checks + ' independent checks');
