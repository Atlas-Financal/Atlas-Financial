'use strict';
// A1: a future-dated or undated balance never becomes current, precise cash.
// Savings: the inventory already refuses a pool balance dated after its own
// observation day; that is pinned here without changing it.
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
const savingsV2 = require('./fixtures/savings-v2-observation-data');

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

// ── A stale (yesterday) balance never replaces today's cash, and the
// refresh never reads "current" on it. ──
{
  const live = Live.fromObservation(world(YESTERDAY));
  eq(billsCash(live.data), 100, 'stale: yesterday\'s 200 never replaces today\'s 100');
  eq(live.overlays.some(r => r.locator === 'cash:chequing-a'), false, 'stale: no cash overlay');
  const trust = live.data.refreshTrust;
  yes(trust.displayState !== 'current', 'stale: refresh trust is not current (' + trust.displayState + ')');
  yes(trust.coverageLimits.some(l => l.id === 'required-cash-balance-stale'),
    'stale: refresh trust names the stale required cash balance');
  eq(Live.fromObservation(world(TODAY)).data.refreshTrust.coverageLimits
    .some(l => l.id === 'required-cash-balance-stale'), false, 'stale control: today-dated cash is not stale');
}

// ── As-of advance: live-plan's freshness assertion is the guard. The
// opening is yesterday; the request day is today. A balance dated tomorrow
// (or undated) never becomes the advanced opening: assertFreshLivePacket
// refuses it, naming the date. A today-dated balance is the control. Any
// later relaxation for balances dated *before* today must keep these. ──
{
  const control = Live.fromObservation(world(TODAY, { openingAsOf: YESTERDAY }));
  eq(billsCash(control.data), 200, 'advance control: today-dated 200 becomes the advanced opening');
  for (const [label, date, named] of [['future-dated', TOMORROW, TOMORROW],
    ['undated', null, 'unknown (no usable balance date)']]) {
    let threw = null;
    let live = null;
    try { live = Live.fromObservation(world(date, { openingAsOf: YESTERDAY })); } catch (e) { threw = e; }
    yes(!live || billsCash(live.data) !== 200, 'advance ' + label + ': 200 never becomes cash');
    yes(threw && /stale-live-cash-evidence: cash:chequing-a dated /.test(threw.message)
      && threw.message.includes(named),
    'advance ' + label + ': the freshness assertion refuses it, naming ' + named);
  }
}

// ── Mortgage and HELOC: opening 900 each; the provider reports 800. A
// balance dated tomorrow, or with no date at all, never replaces 900, never
// becomes a canonical proposal and never reads "current". The request time
// is never borrowed as a loan's balance date. Same-day and as-of-advance. ──
function loanWorld(loanDate, opts = {}) {
  const x = world(TODAY, opts);
  x.payload.accounts[0].balance = 100;
  x.data.debts = [
    { id: 'mortgage', label: 'Invented mortgage', structure: 'Amortizing', secured: true, balance: 900, rate: 0 },
    { id: 'heloc', label: 'Invented HELOC', structure: 'Revolving', secured: true, balance: 900, rate: 0 }];
  for (const [id, pid, role, subtype] of [['mortgage', 3009, 'mortgage', 'mortgage'],
    ['heloc', 3008, 'heloc', 'line_of_credit']]) {
    x.accountMap.mappings.push({ providerAccountId: String(pid), canonical: { collection: 'debts', id }, atlasRole: role });
    const account = { id: pid, name: 'Invented ' + id, type: 'loan', subtype,
      institution_name: 'Invented', currency: 'cad', balance: 800 };
    if (loanDate) { account.updated_at = loanDate + 'T17:00:00Z'; account.balance_as_of = loanDate + 'T17:00:00Z'; }
    x.payload.accounts.push(account);
  }
  return x;
}
const debtBalances = data => data.debts.map(d => d.balance);
{
  const control = Live.fromObservation(loanWorld(TODAY));
  eq(debtBalances(control.data), [800, 800], 'loan control: today-dated 800 overlays both loans');
  eq(control.data.refreshTrust.displayState, 'current', 'loan control: current');
  for (const [label, date, reason] of [['future-dated', TOMORROW, 'balance-date-after-request'],
    ['undated', null, 'no-semantic-balance-date']]) {
    for (const [mode, opts] of [['same-day', {}], ['advance', { openingAsOf: YESTERDAY }]]) {
      const x = loanWorld(date, opts);
      if (mode === 'advance') x.payload.accounts[0].balance_last_update = TODAY + 'T17:00:00Z';
      const report = O.observe({ provider: 'lunchmoney', ...x });
      const obs = report.observations.filter(o => o.canonical && o.canonical.collection === 'debts');
      eq(obs.map(o => [o.unknown, o.unknownReason]), [[true, reason], [true, reason]],
        `loan ${label} ${mode}: observer marks both loans unknown, never borrowing the request time`);
      const live = Live.fromObservation(x);
      eq(debtBalances(live.data), [900, 900], `loan ${label} ${mode}: 900 kept; 800 never replaces it`);
      eq(live.overlays.some(r => /^debts:(mortgage|heloc)$/.test(r.locator)), false,
        `loan ${label} ${mode}: no loan overlay`);
      eq(live.data.refreshTrust.canonicalProposalCount, 0, `loan ${label} ${mode}: no canonical proposal`);
      yes(live.data.refreshTrust.displayState !== 'current', `loan ${label} ${mode}: not current`);
    }
  }
}

// ── Each proposal boundary refuses future evidence on its own, even when
// the observer did not mark the row unknown. Mortgage 900; a CHANGE to 800
// dated tomorrow, on a request dated today. ──
{
  const C = require(path.join(root, 'scripts/canonical-refresh'));
  const fs = require('node:fs');
  const os = require('node:os');
  const row = date => ({ canonicalTarget: 'debts:mortgage', status: 'CHANGE', dateRelation: 'canonical-older',
    evidenceValue: 800, canonicalValue: 900, evidenceDate: date });
  const report = date => ({ fetchedAt: TODAY + 'T18:00:00Z', writesCanonicalState: false,
    reconciliation: { rows: [row(date)] } });
  // live-plan proposal boundary
  const livePlan = Live.proposeOverlay(report(TOMORROW), YESTERDAY, TODAY);
  eq(livePlan.proposed.length, 0, 'live-plan boundary: future CHANGE is not proposed');
  eq(livePlan.refused.map(r => r.reason), ['future-not-current'], 'live-plan boundary: refused as future');
  eq(Live.proposeOverlay(report(TODAY), YESTERDAY, TODAY).proposed.map(r => r.proposedValue), [800],
    'live-plan boundary control: today-dated CHANGE is proposed');
  // canonical preview boundary
  const data = world(TODAY, { openingAsOf: YESTERDAY }).data;
  data.debts = [{ id: 'mortgage', label: 'Invented mortgage', structure: 'Amortizing', secured: true, balance: 900, rate: 0 }];
  const future = C.buildPreview(report(TOMORROW), { data });
  eq([future.proposed.length, future.mechanicallyProvable.length], [0, 0],
    'canonical preview: future CHANGE is never proposed or mechanically provable');
  eq(future.refused.map(r => r.reason), ['future-not-current'], 'canonical preview: refused as future');
  const today = C.buildPreview(report(TODAY), { data });
  eq(today.mechanicallyProvable.map(r => r.proposedValue), [800], 'canonical preview control: today-dated CHANGE is provable');
  // canonical write boundary: a preview carrying future evidence never writes
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-a1-'));
  try {
    const forged = JSON.parse(JSON.stringify(today));
    forged.proposed.forEach(r => { r.evidenceDate = TOMORROW; });
    forged.mechanicallyProvable.forEach(r => { r.evidenceDate = TOMORROW; });
    let refused = null;
    try { C.applyPreview(data, forged, path.join(dir, 'future.json')); } catch (e) { refused = e; }
    yes(refused && /dated after its request day/.test(refused.message), 'canonical apply: future evidence never writes');
    eq(fs.existsSync(path.join(dir, 'future.json')), false, 'canonical apply: no file written');
    const written = C.applyPreview(data, today, path.join(dir, 'today.json'));
    eq(written.debts[0].balance, 800, 'canonical apply control: today-dated preview writes 800 to the invented file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

// ── Savings inventory. The observer dates a pool observation by its own
// request day, and the inventory requires each pool balance to be dated that
// day, so a balance dated after its request is never verified. A real
// observation newer than an older page (the failed-overlay page keeps the
// canonical date) stays valid. ──
{
  // Through the real observer and live plan: savings balance dated tomorrow.
  for (const [mode, expected] of [['valid-v2', [['verified', 95], ['verified', 24]]],
    ['future-date', [['unknown', null], ['verified', 24]]]]) {
    const live = Live.fromObservation(savingsV2.input(mode));
    const pools = F.savingsInventory(live.data.plan, live.data.meta.asOf).pools;
    eq(pools.map(p => [p.observedTrust, p.observedCash]), expected,
      'savings ' + mode + ': only a balance dated its own request day is verified');
  }
  const data = savingsData('ready');
  const day = data.meta.asOf; // 2026-10-05 in the invented fixture
  eq(day, '2026-10-05', 'savings: invented fixture day');
  const plan = JSON.parse(JSON.stringify(data.plan));
  const accounts = plan.savingsPoolObservation.accounts;
  plan.savingsPoolObservation = { asOf: '2026-10-06',
    accounts: accounts.map(r => ({ ...r, evidenceDate: '2026-10-07' })) };
  eq(F.savingsInventory(plan, day).pools.map(p => p.observedTrust), ['unknown', 'unknown'],
    'savings: a balance dated after its observation day is unknown');
  plan.savingsPoolObservation = { asOf: '2026-10-06',
    accounts: accounts.map(r => ({ ...r, evidenceDate: '2026-10-06' })) };
  eq(F.savingsInventory(plan, day).pools.map(p => [p.observedTrust, p.observedCash]),
    [['verified', 95], ['verified', 24]],
    'savings: a newer observation on an older page stays verified (failed-overlay page)');
}

console.log('PASS future-dated or undated balances stay unknown through observe -> reconcile -> live overlay -> refresh trust; savings inventory dating held: '
  + checks + ' independent checks');
