'use strict';
/* Read-only live plan overlay: Lunch Money → observe/reconcile → in-memory
 * current account state → Forecast, without rewriting historical openings.
 *
 * Independent proof is hand arithmetic on named posted/pending/cash
 * amounts (L-002). Live data.json cents are a MATCH baseline, not the
 * expected specification (L-006). Does not write data.json or snapshots.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const vm = require('vm');
const O = require('../scripts/provider-observe.js');
const C = require('../scripts/canonical-refresh.js');
const Live = require('../scripts/live-plan.js');
const OA = require('../scripts/operating-answer.js');
const Assistant = require('../scripts/assistant-packet.js');
const Forecast = require('../public/forecast.js');
const Chequing = require('../public/forecast-chequing.js');
const { sourceText } = require('./test-source-text');
const { independentSpendableOpening } = require('./test-helpers');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data.json');
const MAP = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'b81-account-map.json');
const IDENTITY = path.join(ROOT, 'docs', 'connectivity', 'transaction-identity.json');
const SCRIPT = path.join(ROOT, 'scripts', 'live-plan.js');
const SNAPSHOT_DIR = path.join(ROOT, 'snapshots');
const FETCHED_AT = '2026-08-21T18:00:00.000Z';
const OBSERVED = '2026-08-21T17:55:00.000Z';
const LIVE_AS_OF = '2026-08-21';
const UNKNOWN_SAME_DAY_AT = '2026-08-20T18:00:00.000Z';
const PAYDAY_AT = '2026-08-28T18:00:00.000Z';
const PAYDAY_AS_OF = '2026-08-28';
const NEXT_DAY_AT = '2026-08-29T18:00:00.000Z';
const NEXT_DAY_AS_OF = '2026-08-29';
const PURCHASE = 40;
const CASH_PURCHASE = 30;
const SYNTHETIC_PAYROLL = 1000;
const SYNTHETIC_MORTGAGE_OBSERVED = 1234.56;
const SYNTHETIC_FIT_OBSERVED = 9.99;
const SYNTHETIC_TRANSFER = 19.03;
const SYNTHETIC_CCB = 50;
const CCB_AS_OF = '2026-08-20';
const ELAPSED_WEEKLY = 70;
const UNPAID_INTERVENING = 100;
const UNPAID_BILL_DATE = '2026-08-20';

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const clone = x => JSON.parse(JSON.stringify(x));

const liveData = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const accountMap = JSON.parse(fs.readFileSync(MAP, 'utf8'));
const identity = JSON.parse(fs.readFileSync(IDENTITY, 'utf8'));
const liveHash = hashFile(DATA);
const snapshotHashes = fs.readdirSync(SNAPSHOT_DIR)
  .filter(name => name.endsWith('.json'))
  .sort()
  .map(name => `${name}:${hashFile(path.join(SNAPSHOT_DIR, name))}`);

function cashValue(data, id) {
  const rows = ((data.plan && data.plan.startingCash && data.plan.startingCash.breakdown) || []);
  const row = rows.find(r => r && r.id === id);
  return row ? Number(row.value) : null;
}

function debt(data, id) {
  return ((data.debts || []).find(d => d && d.id === id)) || null;
}

function independentUsed(posted, pending) {
  return Math.round((Number(posted) + Number(pending || 0)) * 100) / 100;
}

function independentAvailable(posted, pending, limit) {
  return Math.round(Math.max(0, Number(limit) - independentUsed(posted, pending)) * 100) / 100;
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
  const accounts = [
    {
      id: 3001, name: 'BILLS ACCOUNT', type: 'cash', subtype: 'checking',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t['chequing-a'] != null ? t['chequing-a'] : cashValue(data, 'chequing-a'),
      updated_at: t.cashAt || OBSERVED,
      ...(t.omitCashBalanceDate ? {} : { balance_last_update: t.cashBalanceDate !== undefined ? t.cashBalanceDate : (t.cashAt || OBSERVED) }),
    },
    {
      id: 3002, name: 'WEEKLY SPENDING', type: 'cash', subtype: 'checking',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t['chequing-b'] != null ? t['chequing-b'] : cashValue(data, 'chequing-b'),
      updated_at: t.cashAt || OBSERVED,
      ...(t.omitCashBalanceDate ? {} : { balance_last_update: t.cashBalanceDate !== undefined ? t.cashBalanceDate : (t.cashAt || OBSERVED) }),
    },
    {
      id: 3003, name: 'EMERGENCY SAVING', type: 'cash', subtype: 'savings',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.savings != null ? t.savings : cashValue(data, 'savings'),
      updated_at: t.savingsAt || t.cashAt || OBSERVED,
      ...(t.omitCashBalanceDate ? {} : { balance_last_update: t.cashBalanceDate !== undefined ? t.cashBalanceDate : (t.savingsAt || t.cashAt || OBSERVED) }),
    },
    {
      id: 3004, name: 'PERSONAL CREDIT CARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.tdcc != null ? t.tdcc : debt(data, 'tdcc').balance,
      credit_limit: debt(data, 'tdcc').limit,
      available_balance: t.tdccAvailable,
      updated_at: t.cardAt || OBSERVED,
    },
    {
      id: 3005, name: 'TD CASH BACK VISA* CARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.cashback != null ? t.cashback : debt(data, 'cashback').balance,
      credit_limit: debt(data, 'cashback').limit,
      available_balance: t.cashbackAvailable,
      updated_at: t.cardAt || OBSERVED,
    },
    {
      id: 3006, name: 'TRAVEL VISA', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.travelvisa != null ? t.travelvisa : debt(data, 'travelvisa').balance,
      credit_limit: debt(data, 'travelvisa').limit,
      updated_at: t.cardAt || OBSERVED,
    },
    {
      id: 3007, name: 'LINE OF CREDIT - HOME EQUITY', type: 'loan', subtype: 'line_of_credit',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.heloc != null ? t.heloc : debt(data, 'heloc').balance,
      updated_at: t.loanAt || OBSERVED,
    },
    {
      id: 3008, name: 'MORTGAGE', type: 'loan', subtype: 'mortgage',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.mortgage != null ? t.mortgage : debt(data, 'mortgage').balance,
      updated_at: t.loanAt || OBSERVED,
    },
    {
      id: 3010, name: 'TRIANGLE MASTERCARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'Canadian Tire Bank', currency: 'cad',
      balance: t.triangle != null ? t.triangle : debt(data, 'triangle').balance,
      credit_limit: debt(data, 'triangle').limit,
      updated_at: t.triangleAt || OBSERVED,
    },
  ];
  if (t.unmapped) {
    accounts.push({
      id: 3999, name: 'Unmapped Extra', type: 'cash',
      institution_name: 'Unknown', currency: 'cad',
      balance: 50, updated_at: OBSERVED,
    });
  }
  if (t.omitProviderIds && t.omitProviderIds.length) {
    const omit = new Set(t.omitProviderIds);
    return accounts.filter(account => !omit.has(account.id));
  }
  return accounts;
}

function payloadFrom(data, extra) {
  const extraPayload = extra || {};
  const payload = {
    provider: 'lunchmoney',
    fetchedAt: extraPayload.fetchedAt || FETCHED_AT,
    source: 'Synthetic live-plan fixture. Not a live institution pull. Fixture IDs 3001–3010 are not live provider IDs.',
    pendingCoverage: extraPayload.pendingCoverage === undefined
      ? completePendingCoverage()
      : extraPayload.pendingCoverage,
    accounts: matchingAccounts(data, extraPayload.tweaks),
    transactions: (extraPayload.transactions || []).map(row => ({ currency: 'cad', ...row })),
  };
  if (extraPayload.categories) payload.categories = extraPayload.categories;
  if (extraPayload.transactionWindow) payload.transactionWindow = extraPayload.transactionWindow;
  return payload;
}

function overlay(data, extra) {
  return Live.fromObservation({
    data,
    payload: payloadFrom(data, extra),
    accountMap,
    identity,
  });
}

function snapshotState() {
  return fs.readdirSync(SNAPSHOT_DIR)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => `${name}:${hashFile(path.join(SNAPSHOT_DIR, name))}`);
}

function filesUnchanged(label) {
  ok(hashFile(DATA) === liveHash, `${label}: data.json bytes unchanged`);
  const now = snapshotState();
  ok(now.length === snapshotHashes.length
    && now.every((row, i) => row === snapshotHashes[i]),
    `${label}: snapshots unchanged`);
}

console.log('=== 1. overlay defaults off and does not write ===');
{
  ok(Live.overlayModeFromEnv({}) === 'off', 'missing env is overlay off');
  ok(Live.overlayModeFromEnv({ ATLAS_LIVE_OVERLAY: '1' }) === 'off',
    'ATLAS_LIVE_OVERLAY=1 is not a live fetch');
  ok(Live.overlayModeFromEnv({ ATLAS_LIVE_OVERLAY: 'fixture' }) === 'fixture',
    'fixture mode is explicit');
  const render = fs.existsSync(path.join(ROOT, 'render.yaml'))
    ? fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8')
    : '';
  ok(/key:\s*ATLAS_LIVE_OVERLAY[\s\S]*?value:\s*"live"/.test(render),
    'Render enables the incumbent live overlay');
  ok(/key:\s*LUNCHMONEY_ACCESS_TOKEN[\s\S]*?sync:\s*false/.test(render),
    'Render declares Lunch Money token as owner-supplied');
  ok(!/key:\s*LUNCHMONEY_ACCESS_TOKEN[\s\S]*?value:/.test(render),
    'Render does not assign a Lunch Money token value');
  ok(/key:\s*ATLAS_PROVIDER_ACCOUNT_MAP_JSON[\s\S]*?sync:\s*false/.test(render),
    'Render declares private account-map JSON as owner-supplied');
  ok(!/key:\s*ATLAS_PROVIDER_ACCOUNT_MAP_JSON[\s\S]*?value:/.test(render),
    'Render does not assign account-map JSON');
  const served = Live.serveCanonicalOrFixture(liveData, {});
  ok(served === liveData || served.liveOverlay == null,
    'server overlay off returns the dated opening');
  ok(!served.liveOverlay, 'no liveOverlay metadata when overlay is off');
  filesUnchanged('default off');
}

console.log('\n=== 2. pending purchase overlays utilisation, not the file ===');
{
  const canonical = clone(liveData);
  const card = debt(canonical, 'cashback');
  const posted = Number(card.balance);
  const pendingBefore = Number(card.pending || 0);
  const limit = Number(card.limit);
  const expectedUsed = independentUsed(posted, pendingBefore + PURCHASE);
  const expectedAvail = independentAvailable(posted, pendingBefore + PURCHASE, limit);
  const beforeAvail = independentAvailable(posted, pendingBefore, limit);
  const utilBefore = Forecast.utilisation(canonical.debts, canonical.revolvingExtra, canonical.plan);
  const rowBefore = utilBefore.rows.find(r => r.id === 'cashback');

  const result = overlay(canonical, {
    transactions: [{
      id: 91001,
      account_id: 3005,
      date: LIVE_AS_OF,
      amount: PURCHASE,
      payee: 'SYNTHETIC GROCER',
      is_pending: true,
      status: 'unreviewed',
    }],
  });

  ok(result.writesCanonicalState === false, 'overlay declares no canonical write');
  ok(result.data.liveOverlay && result.data.liveOverlay.applied === true,
    'liveOverlay metadata marks the in-memory clone applied');
  ok(result.data.liveOverlay.writesCanonicalState === false,
    'metadata says writesCanonicalState false');
  ok(String(result.data.liveOverlay.historicalOpeningAsOf) === String(canonical.plan.opening.asOf),
    'historical opening as-of is recorded on the overlay, not discarded');
  ok(String(result.data.meta.asOf) === LIVE_AS_OF,
    'in-memory meta.asOf is the observation household date');
  ok(String(result.data.plan.opening.asOf) === LIVE_AS_OF,
    'in-memory plan.opening.asOf is the live Forecast start');
  ok(String(canonical.meta.asOf) === String(liveData.meta.asOf),
    'the caller canonical clone is not rewritten');
  ok(String(result.data.liveOverlay.effectiveAsOf) === LIVE_AS_OF,
    'overlay metadata names the live effective as-of');
  ok(near(debt(result.data, 'cashback').pending, pendingBefore + PURCHASE),
    'Cash Back pending overlays the synthetic purchase',
    String(debt(result.data, 'cashback').pending));
  ok(near(debt(result.data, 'cashback').balance, posted),
    'posted Cash Back balance is not rewritten by a pending purchase');

  const utilAfter = Forecast.utilisation(result.data.debts, result.data.revolvingExtra, result.data.plan);
  const rowAfter = utilAfter.rows.find(r => r.id === 'cashback');
  ok(rowAfter && near(rowAfter.used, expectedUsed),
    'Forecast.utilisation used matches posted + pending by hand',
    rowAfter && String(rowAfter.used));
  ok(rowAfter && near(rowAfter.available, expectedAvail),
    'Forecast.utilisation available matches limit − used by hand',
    rowAfter && String(rowAfter.available));
  ok(rowBefore && near(rowBefore.available - rowAfter.available, PURCHASE),
    'available credit falls by the synthetic purchase, not by an invented amount');
  ok(near(beforeAvail - expectedAvail, PURCHASE),
    'independent available delta is the purchase amount');
  ok(JSON.stringify(result.data.plan.income) === JSON.stringify(canonical.plan.income),
    'plan.income is untouched');
  ok(JSON.stringify(result.data.plan.bills) === JSON.stringify(canonical.plan.bills),
    'plan.bills are untouched');
  ok(JSON.stringify(result.data.plan.commitments) === JSON.stringify(canonical.plan.commitments),
    'plan.commitments are untouched');
  filesUnchanged('pending purchase');
}

console.log('\n=== 3. posted cash purchase moves starting cash and safe-to-spend ===');
{
  const canonical = clone(liveData);
  const cashBefore = Forecast.startingCashAmount(canonical.plan);
  const cheqBefore = cashValue(canonical, 'chequing-a');
  const expectedCash = Math.round((cashBefore - CASH_PURCHASE) * 100) / 100;
  const recBefore = Forecast.recommend(canonical.plan, canonical.plan.opening.asOf, {
    fundingSources: canonical.plan.funding && canonical.plan.funding.options,
    debts: canonical.debts,
    revolvingExtra: canonical.revolvingExtra,
  });

  const result = overlay(canonical, {
    tweaks: { 'chequing-a': cheqBefore - CASH_PURCHASE },
    transactions: [{
      id: 91002,
      account_id: 3001,
      date: LIVE_AS_OF,
      amount: CASH_PURCHASE,
      payee: 'SYNTHETIC STORE',
      is_pending: false,
      status: 'reviewed',
    }],
  });

  const cashAfter = Forecast.startingCashAmount(result.data.plan);
  ok(near(cashAfter, expectedCash),
    'Forecast.startingCashAmount falls by the synthetic cash purchase',
    String(cashAfter));
  ok(near(cashValue(result.data, 'chequing-a'), cheqBefore - CASH_PURCHASE),
    'Chequing A overlays the posted purchase');
  ok(near(cashValue(canonical, 'chequing-a'), cheqBefore),
    'the in-memory canonical clone passed in is not required to mutate; overlay returns a new document');
  ok(near(cashValue(liveData, 'chequing-a'), cheqBefore),
    'live data.json Chequing A is still the dated opening');

  const recAfter = Forecast.recommend(result.data.plan, result.data.meta.asOf, {
    fundingSources: result.data.plan.funding && result.data.plan.funding.options,
    debts: result.data.debts,
    revolvingExtra: result.data.revolvingExtra,
  });
  ok(recAfter && (recAfter.weekly != null || recAfter.mode === 'infeasible'),
    'Forecast.recommend still answers on the overlaid opening');
  if (recBefore.mode !== 'infeasible' && recAfter.mode !== 'infeasible') {
    ok(recAfter.weekly <= recBefore.weekly + 0.005,
      'safe-to-spend does not rise after a cash purchase',
      `${recBefore.weekly} → ${recAfter.weekly}`);
  } else {
    ok(recBefore.mode === recAfter.mode || recAfter.mode === 'infeasible',
      'a cash purchase does not invent a newly feasible cap');
  }
  const figures = Live.forecastFrom(result.data);
  ok(figures.asOf === LIVE_AS_OF,
    'live-plan Forecast summary starts on the observation household date');
  ok(near(figures.startingCash, expectedCash),
    'live-plan Forecast summary uses the overlaid starting cash');
  filesUnchanged('cash purchase');
}

console.log('\n=== 4. available credit is never cash; transfers are not income ===');
{
  const canonical = clone(liveData);
  const cashBefore = Forecast.startingCashAmount(canonical.plan);
  const incomeBefore = JSON.stringify(canonical.plan.income);
  const result = overlay(canonical, {
    tweaks: { cashbackAvailable: 10000 },
    transactions: [{
      id: 91003,
      account_id: 3001,
      date: LIVE_AS_OF,
      amount: -200,
      payee: 'SEASPAN PAYROLL',
      is_pending: false,
      status: 'reviewed',
    }],
  });
  ok(near(Forecast.startingCashAmount(result.data.plan), cashBefore),
    'available credit 10000 does not enter spendable cash');
  ok(JSON.stringify(result.data.plan.income) === incomeBefore,
    'an inbound transfer transaction is not promoted into plan.income');
  ok(result.refused.some(r => r.reason === 'credit-capacity-not-cash'),
    'available-credit / limit facts are refused as credit-capacity-not-cash');
  const spendable = O.spendableCashFromObservations(result.report.observations);
  const independentPostedCash = independentDatedCash(result.data.plan);
  ok(near(spendable, independentPostedCash)
      && !near(spendable, cashBefore)
      && near(Forecast.startingCashAmount(result.data.plan), cashBefore),
    'observer posted-cash evidence includes designated savings; Forecast opening stays chequing-only');
  filesUnchanged('credit and transfer');
}

console.log('\n=== 5. Triangle cadence keeps canonical; unmapped and conflict fail closed ===');
{
  const canonical = clone(liveData);
  const trianglePosted = Number(debt(canonical, 'triangle').balance);
  const result = overlay(canonical, {
    tweaks: {
      triangle: trianglePosted - 185.62,
      triangleAt: '2026-08-18T17:55:00.000Z',
      unmapped: true,
    },
  });
  ok(near(debt(result.data, 'triangle').balance, trianglePosted),
    'stale Triangle Lunch Money does not overlay over the cadence-accepted opening');
  ok(result.refused.some(r => r.reason === 'statement-cadence-keep-canonical'
    || r.reason === 'stale-not-current'),
    'Triangle stale evidence is refused rather than invented');
  ok(result.refused.some(r => r.reason === 'unmapped-provider-account'),
    'unmapped provider accounts fail closed');

  const conflicted = Live.overlayLiveState({
    data: canonical,
    report: {
      writesCanonicalState: false,
      fetchedAt: `${canonical.plan.opening.asOf}T18:00:00.000Z`,
      pendingCoverage: completePendingCoverage(),
      unmapped: [],
      representedEventCandidates: [],
      reconciliation: {
        rows: [{
          fact: null,
          status: 'CONFLICT',
          canonicalTarget: 'cash:chequing-a',
          canonicalValue: cashValue(canonical, 'chequing-a'),
          evidenceValue: cashValue(canonical, 'chequing-a') - 10,
          evidenceDate: canonical.plan.opening.asOf,
          dateRelation: 'same-day',
        }],
      },
    },
  });
  ok(near(cashValue(conflicted.data, 'chequing-a'), cashValue(canonical, 'chequing-a')),
    'CONFLICT does not overlay a guessed Chequing A value');
  ok(conflicted.refused.some(r => r.reason === 'conflicting-observations'),
    'CONFLICT is refused as conflicting-observations');
  filesUnchanged('cadence and conflict');
}

console.log('\n=== 6. unknown pending is not invented as zero ===');
{
  const canonical = clone(liveData);
  canonical.debts = canonical.debts.map(row => {
    if (row.id !== 'cashback') return row;
    return Object.assign({}, row, { pending: 25, pendingUnknown: false });
  });
  let threw = null;
  try {
    overlay(canonical, {
      pendingCoverage: null,
      transactions: [],
    });
  } catch (err) {
    threw = err;
  }
  ok(threw && /pending-freshness-unproven/.test(threw.message),
    'incomplete pending census fails closed rather than advancing the Forecast clock',
    threw && threw.message);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-live-plan-pending-'));
  const fixture = path.join(dir, 'fixture.json');
  fs.writeFileSync(fixture, `${JSON.stringify(payloadFrom(canonical, {
    pendingCoverage: null,
    transactions: [],
  }), null, 2)}\n`);
  const served = Live.serveCanonicalOrFixture(canonical, {
    ATLAS_LIVE_OVERLAY: 'fixture',
    ATLAS_LIVE_OVERLAY_FIXTURE: fixture,
    ATLAS_LIVE_OVERLAY_MAP: MAP,
  });
  ok(served.liveOverlay && served.liveOverlay.applied === false,
    'server overlay returns the dated opening when pending freshness is unproven');
  ok(near(debt(served, 'cashback').pending, 25),
    'incomplete pending census does not overlay $0 over known pending');
  ok(String(served.meta.asOf) === String(canonical.meta.asOf),
    'unproven pending does not advance the served as-of');
  filesUnchanged('unknown pending');
}

console.log('\n=== 7. CLI fixture run is read-only and sanitized ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-live-plan-'));
  const fixture = path.join(dir, 'fixture.json');
  const canonical = clone(liveData);
  fs.writeFileSync(fixture, `${JSON.stringify(payloadFrom(canonical, {
    tweaks: { 'chequing-a': cashValue(canonical, 'chequing-a') - CASH_PURCHASE },
  }), null, 2)}\n`);
  const stdout = execFileSync(process.execPath, [
    SCRIPT,
    '--fixture', fixture,
    '--map', MAP,
    '--data', DATA,
  ], { cwd: ROOT, encoding: 'utf8' });
  const parsed = JSON.parse(stdout);
  ok(parsed.writesCanonicalState === false, 'CLI JSON says writesCanonicalState false');
  ok(parsed.overlayCount >= 1, 'CLI overlay applied the cash CHANGE');
  ok(parsed.effectiveAsOf === LIVE_AS_OF, 'CLI reports the live effective as-of');
  ok(parsed.forecast && parsed.forecast.asOf === LIVE_AS_OF,
    'CLI Forecast starts on the observation household date');
  ok(parsed.forecast && near(parsed.forecast.startingCash,
    Forecast.startingCashAmount(canonical.plan) - CASH_PURCHASE),
    'CLI Forecast starting cash matches the independent purchase delta');
  ok(!/"providerAccountId"\s*:/.test(stdout), 'CLI output has no providerAccountId');
  ok(!/LUNCHMONEY_ACCESS_TOKEN/.test(stdout), 'CLI output has no token env name as a secret');
  ok(!/Bearer\s+\S+/.test(stdout), 'CLI output has no Bearer token');
  filesUnchanged('CLI fixture');
}

console.log('\n=== 8. server fixture overlay does not mutate the cached opening ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-live-plan-srv-'));
  const fixture = path.join(dir, 'fixture.json');
  const canonical = clone(liveData);
  fs.writeFileSync(fixture, `${JSON.stringify(payloadFrom(canonical, {
    transactions: [{
      id: 91004,
      account_id: 3005,
      date: LIVE_AS_OF,
      amount: PURCHASE,
      payee: 'SYNTHETIC GROCER',
      is_pending: true,
      status: 'unreviewed',
    }],
  }), null, 2)}\n`);
  const served = Live.serveCanonicalOrFixture(canonical, {
    ATLAS_LIVE_OVERLAY: 'fixture',
    ATLAS_LIVE_OVERLAY_FIXTURE: fixture,
    ATLAS_LIVE_OVERLAY_MAP: MAP,
  });
  ok(served !== canonical, 'server overlay returns a clone');
  ok(served.liveOverlay && served.liveOverlay.applied === true,
    'served payload carries liveOverlay metadata');
  ok(String(served.meta.asOf) === LIVE_AS_OF,
    'served clone Forecast start is the observation household date');
  ok(String(canonical.meta.asOf) === String(liveData.meta.asOf),
    'the cached canonical object keeps the dated opening as-of');
  ok(near(debt(served, 'cashback').pending, Number(debt(canonical, 'cashback').pending || 0) + PURCHASE),
    'served clone has the pending purchase');
  ok(near(debt(canonical, 'cashback').pending, Number(debt(liveData, 'cashback').pending || 0)),
    'the cached canonical object is not mutated');
  ok(near(cashValue(liveData, 'chequing-a'), cashValue(canonical, 'chequing-a')),
    'live data.json is still the dated opening after server overlay');
  filesUnchanged('server fixture overlay');
}

console.log('\n=== 9. unknown same-day income is not counted and does not discard cash ===');
{
  const canonical = clone(liveData);
  const independentCash = Math.round((
    Number(cashValue(canonical, 'chequing-a')) +
    Number(cashValue(canonical, 'chequing-b'))
  ) * 100) / 100;
  const result = overlay(canonical, {
    fetchedAt: UNKNOWN_SAME_DAY_AT,
    tweaks: { cashAt: '2026-08-20T17:55:00.000Z' },
  });
  ok(result.data.liveOverlay.applied === true,
    'Aug 20 overlay keeps complete current cash when child benefit is unproven');
  ok(result.data.liveOverlay.operatingPlan === Live.OPERATING_PLAN_LIVE,
    'operating plan stays live on unproven same-day inbound');
  ok(!(result.data.plan.opening.representedEvents || [])
      .some(row => row.id === 'childBenefit' && row.date === CCB_AS_OF),
    'unproven child benefit is not named represented');
  const notRelied = (result.data.plan.opening.notReliedUponEvents || [])
    .find(row => row.id === 'childBenefit' && row.date === CCB_AS_OF);
  ok(notRelied && notRelied.reason === 'same-day-inbound-unproven',
    'unproven child benefit is not-relied-upon rather than fail-closed');
  ok(near(Forecast.startingCashAmount(result.data.plan), independentCash),
    'Forecast opening is the observed household-cash sum');
  const advice = Forecast.recommend(result.data.plan, CCB_AS_OF, {
    debts: result.data.debts,
    operatingPlan: result.data.liveOverlay.operatingPlan,
  });
  ok(advice.paydayAllocation && !near(advice.paydayAllocation.available,
      independentCash + SYNTHETIC_CCB)
      && near(advice.paydayAllocation.available, independentCash),
    'unproven child benefit is not added on top of observed cash');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-live-plan-sameday-'));
  const fixture = path.join(dir, 'fixture.json');
  fs.writeFileSync(fixture, `${JSON.stringify(payloadFrom(canonical, {
    fetchedAt: UNKNOWN_SAME_DAY_AT,
    tweaks: { cashAt: '2026-08-20T17:55:00.000Z' },
  }), null, 2)}\n`);
  const served = Live.serveCanonicalOrFixture(canonical, {
    ATLAS_LIVE_OVERLAY: 'fixture',
    ATLAS_LIVE_OVERLAY_FIXTURE: fixture,
    ATLAS_LIVE_OVERLAY_MAP: MAP,
  });
  ok(served.liveOverlay && served.liveOverlay.applied === true,
    'server overlay applies complete current cash when same-day inbound is unproven');
  ok(String(served.meta.asOf) === CCB_AS_OF,
    'applied overlay advances the served as-of');
  ok(String(served.plan.opening.asOf) === CCB_AS_OF,
    'applied overlay advances the served opening');
  filesUnchanged('unknown same-day');
}

console.log('\n=== 10. posted payroll in the live balance is not emitted again ===');
{
  const canonical = clone(liveData);
  canonical.plan = Object.assign({}, canonical.plan, {
    income: [{
      id: 'payroll',
      label: 'Synthetic payroll',
      frequency: 'biweekly',
      anchor: '2026-08-14',
      amount: SYNTHETIC_PAYROLL,
      confidence: 'confirmed',
    }],
    bills: [],
    obligations: [],
    commitments: [],
  });
  const cheqBefore = cashValue(canonical, 'chequing-a');
  const expectedCash = Math.round((cheqBefore + SYNTHETIC_PAYROLL) * 100) / 100;
  const histAsOf = canonical.plan.opening.asOf;
  const replayBeforeCutover = Forecast.expandEvents(canonical.plan, histAsOf, PAYDAY_AS_OF, {})
    .filter(e => e.id === 'payroll' && e.date === PAYDAY_AS_OF);
  ok(replayBeforeCutover.length === 1,
    'dated opening from 19 Aug would still emit the 28 Aug payroll');
  ok(near(replayBeforeCutover[0].amount, SYNTHETIC_PAYROLL),
    'replayed payroll amount is the synthetic figure, not a live household cent');

  const result = overlay(canonical, {
    fetchedAt: PAYDAY_AT,
    tweaks: {
      'chequing-a': cheqBefore + SYNTHETIC_PAYROLL,
      cashAt: '2026-08-28T17:55:00.000Z',
    },
    transactions: [{
      id: 91028,
      account_id: 3001,
      date: PAYDAY_AS_OF,
      amount: -SYNTHETIC_PAYROLL,
      payee: 'SEASPAN PAYROLL',
      is_pending: false,
      status: 'reviewed',
    }],
  });

  ok(result.data.liveOverlay && result.data.liveOverlay.applied === true,
    'payday overlay applies when the posted payroll is identified');
  ok(String(result.data.meta.asOf) === PAYDAY_AS_OF,
    'in-memory as-of is payday');
  ok((result.data.plan.opening.representedEvents || [])
    .some(e => e.id === 'payroll' && e.date === PAYDAY_AS_OF),
    'posted payroll is named on the in-memory live opening');
  ok(near(cashValue(result.data, 'chequing-a'), expectedCash),
    'Chequing A includes the synthetic payroll by hand',
    String(cashValue(result.data, 'chequing-a')));

  const liveEvents = Forecast.expandEvents(result.data.plan, PAYDAY_AS_OF, PAYDAY_AS_OF, {});
  ok(!liveEvents.some(e => e.id === 'payroll' && e.date === PAYDAY_AS_OF),
    'Forecast does not emit the posted payroll again on the live as-of');
  const replay = Forecast.expandEvents(result.data.plan, histAsOf, PAYDAY_AS_OF, {});
  ok(replay.some(e => e.id === 'payroll' && e.date === PAYDAY_AS_OF),
    'starting from the historical opening would still replay payday — the cutover is what prevents it');
  filesUnchanged('posted payroll');
}

console.log('\n=== 11. a later live purchase changes the plan without replaying elapsed days ===');
{
  const canonical = clone(liveData);
  const cashBefore = Forecast.startingCashAmount(canonical.plan);
  const expectedCash = Math.round((cashBefore - CASH_PURCHASE) * 100) / 100;
  const histAsOf = canonical.plan.opening.asOf;
  const result = overlay(canonical, {
    tweaks: { 'chequing-a': cashValue(canonical, 'chequing-a') - CASH_PURCHASE },
    transactions: [{
      id: 91021,
      account_id: 3001,
      date: LIVE_AS_OF,
      amount: CASH_PURCHASE,
      payee: 'SYNTHETIC STORE',
      is_pending: false,
      status: 'reviewed',
    }],
  });
  ok(near(Forecast.startingCashAmount(result.data.plan), expectedCash),
    'live starting cash falls by the synthetic purchase');
  ok(String(result.data.meta.asOf) === LIVE_AS_OF,
    'Forecast start is the later observation date');

  const elapsed = Forecast.diffDays(histAsOf, LIVE_AS_OF);
  ok(elapsed > 0, 'observation is after the dated opening');
  const expectedElapsedVariable = Math.round((ELAPSED_WEEKLY / 7) * elapsed * 100) / 100;
  const replay = Forecast.simulate(result.data.plan, histAsOf, {
    weeklyVariable: ELAPSED_WEEKLY, viewDays: 14, horizonDays: 14,
  });
  const coherent = Forecast.simulate(result.data.plan, LIVE_AS_OF, {
    weeklyVariable: ELAPSED_WEEKLY, viewDays: 14, horizonDays: 14,
  });
  const replayElapsed = (replay.daily || []).filter(d => d.date < LIVE_AS_OF);
  ok(replayElapsed.length === elapsed,
    'historical start walks the elapsed days against already-live cash');
  ok(near(replayElapsed.length * (ELAPSED_WEEKLY / 7), expectedElapsedVariable),
    'elapsed variable spend is weekly/7 times elapsed days by hand');
  ok((coherent.daily || []).every(d => d.date >= LIVE_AS_OF),
    'live as-of does not replay elapsed calendar days');
  ok(!Forecast.expandEvents(result.data.plan, LIVE_AS_OF, LIVE_AS_OF, {})
    .some(e => e.id === 'childBenefit' && e.date === '2026-08-20'),
    'intervening 20 Aug child benefit is not emitted on the live start');
  ok(Forecast.expandEvents(canonical.plan, histAsOf, LIVE_AS_OF, {})
    .some(e => e.id === 'childBenefit' && e.date === '2026-08-20'),
    'the dated opening would still have emitted that intervening child benefit');
  filesUnchanged('elapsed days');
}

console.log('\n=== 11b. N1: an old cash balance date is judged by the freshness gate ===');
{
  const canonical = clone(liveData);
  // Balance dated Aug 19, object updated at the fetch time (Aug 21): the update time
  // must not stand in for the balance date.
  let threw = null;
  try {
    overlay(canonical, { fetchedAt: FETCHED_AT, tweaks: { cashBalanceDate: '2026-08-19T17:55:00.000Z' } });
  } catch (err) { threw = err; }
  ok(threw && /stale-live-cash-evidence/.test(threw.message) && /dated 2026-08-19/.test(threw.message),
    'a cash balance dated Aug 19 with a fresh object update time is refused as stale, naming Aug 19',
    threw && threw.message);
  let nullThrew = null;
  try {
    overlay(canonical, { fetchedAt: FETCHED_AT, tweaks: { cashBalanceDate: null } });
  } catch (err) { nullThrew = err; }
  ok(nullThrew && /live-cash-evidence/.test(nullThrew.message),
    'a null semantic balance date is not repaired by the object update or fetch time',
    nullThrew && nullThrew.message);
  // Absent semantic date: the object update time (fresh) and the fetch time must not repair it.
  let absentThrew = null;
  try {
    overlay(canonical, { fetchedAt: FETCHED_AT, tweaks: { omitCashBalanceDate: true } });
  } catch (err) { absentThrew = err; }
  ok(absentThrew && /stale-live-cash-evidence/.test(absentThrew.message)
      && /no usable balance date/.test(absentThrew.message),
    'cash with a fresh update time but no semantic balance date fails closed, naming the reason',
    absentThrew && absentThrew.message);
  let freshThrew = null;
  try {
    overlay(canonical, { fetchedAt: FETCHED_AT, tweaks: { cashBalanceDate: OBSERVED } });
  } catch (err) { freshThrew = err; }
  ok(!freshThrew, 'control: a cash balance dated the live day is accepted', freshThrew && freshThrew.message);
}

console.log('\n=== 12. stale MATCH cash does not advance Forecast or skip elapsed events ===');
{
  const canonical = clone(liveData);
  const histAsOf = canonical.plan.opening.asOf;
  let threw = null;
  try {
    overlay(canonical, {
      fetchedAt: FETCHED_AT,
      tweaks: { cashAt: '2026-08-19T17:55:00.000Z' },
    });
  } catch (err) {
    threw = err;
  }
  ok(threw && /stale-live-cash-evidence/.test(threw.message),
    'later fetch with Aug 19 MATCH cash fails closed',
    threw && threw.message);
  ok(threw && /MATCH is not freshness/.test(threw.message),
    'failure names MATCH is not freshness');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-live-plan-stale-match-'));
  const fixture = path.join(dir, 'fixture.json');
  fs.writeFileSync(fixture, `${JSON.stringify(payloadFrom(canonical, {
    fetchedAt: FETCHED_AT,
    tweaks: { cashAt: '2026-08-19T17:55:00.000Z' },
  }), null, 2)}\n`);
  const served = Live.serveCanonicalOrFixture(canonical, {
    ATLAS_LIVE_OVERLAY: 'fixture',
    ATLAS_LIVE_OVERLAY_FIXTURE: fixture,
    ATLAS_LIVE_OVERLAY_MAP: MAP,
  });
  ok(served.liveOverlay && served.liveOverlay.applied === false,
    'server overlay keeps the dated opening when MATCH cash is stale');
  ok(/stale-live-cash-evidence/.test(String(served.liveOverlay.reason || '')),
    'failed overlay names stale live cash evidence');
  ok(String(served.meta.asOf) === String(histAsOf),
    'stale MATCH does not advance meta.asOf');
  ok(String(served.plan.opening.asOf) === String(histAsOf),
    'stale MATCH does not advance plan.opening.asOf');
  ok(Forecast.expandEvents(served.plan, histAsOf, LIVE_AS_OF, {})
    .some(e => e.id === 'childBenefit' && e.date === '2026-08-20'),
    'elapsed 20 Aug child benefit is not skipped when the opening does not advance');
  filesUnchanged('stale MATCH cash');
}

console.log('\n=== 13. unmapped required cash does not advance Forecast or skip elapsed events ===');
{
  const canonical = clone(liveData);
  const histAsOf = canonical.plan.opening.asOf;
  let threw = null;
  try {
    overlay(canonical, {
      tweaks: { omitProviderIds: [3001] },
    });
  } catch (err) {
    threw = err;
  }
  ok(threw && /missing-live-cash-evidence/.test(threw.message),
    'missing Chequing A evidence fails closed',
    threw && threw.message);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-live-plan-unmap-cash-'));
  const fixture = path.join(dir, 'fixture.json');
  fs.writeFileSync(fixture, `${JSON.stringify(payloadFrom(canonical, {
    tweaks: { omitProviderIds: [3001] },
  }), null, 2)}\n`);
  const served = Live.serveCanonicalOrFixture(canonical, {
    ATLAS_LIVE_OVERLAY: 'fixture',
    ATLAS_LIVE_OVERLAY_FIXTURE: fixture,
    ATLAS_LIVE_OVERLAY_MAP: MAP,
  });
  ok(served.liveOverlay && served.liveOverlay.applied === false,
    'server overlay keeps the dated opening when required cash is missing');
  ok(/missing-live-cash-evidence/.test(String(served.liveOverlay.reason || '')),
    'failed overlay names missing live cash evidence');
  ok(String(served.plan.opening.asOf) === String(histAsOf),
    'unmapped required cash does not advance the opening');
  ok(Forecast.expandEvents(served.plan, histAsOf, LIVE_AS_OF, {})
    .some(e => e.id === 'childBenefit' && e.date === '2026-08-20'),
    'elapsed 20 Aug child benefit is not skipped when required cash is missing');
  filesUnchanged('unmapped required cash');
}

console.log('\n=== 14. intervening unpaid joint-cash outflow stays reserved ===');
{
  const unpaidBill = {
    id: 'synthetic-unpaid-bill',
    label: 'Synthetic intervening unpaid bill',
    frequency: 'monthly',
    day: 20,
    amount: UNPAID_INTERVENING,
    confidence: 'confirmed',
    budgetCategory: 'household',
  };
  const enginePlan = {
    income: [],
    obligations: [],
    bills: [unpaidBill],
    commitments: [],
    startingCash: { amount: 1000 },
    opening: {
      asOf: LIVE_AS_OF,
      priorAsOf: liveData.plan.opening.asOf,
      representedEvents: [],
    },
  };
  const engineEvents = Forecast.expandEvents(enginePlan, LIVE_AS_OF, LIVE_AS_OF, {});
  const engineHit = engineEvents.find(e => e.id === unpaidBill.id && e.date === UNPAID_BILL_DATE);
  ok(engineHit && near(-engineHit.amount, UNPAID_INTERVENING),
    'Forecast.expandEvents reserves the unpaid $100 from priorAsOf without overlayLiveState');
  ok(!Forecast.expandEvents(Object.assign({}, enginePlan, {
    opening: { asOf: LIVE_AS_OF, representedEvents: [] },
  }), LIVE_AS_OF, LIVE_AS_OF, {}).some(e => e.id === unpaidBill.id),
    'without priorAsOf the recurring intervening bill disappears — the overlay bug');
  ok(!Forecast.expandEvents(Object.assign({}, enginePlan, {
    opening: {
      asOf: LIVE_AS_OF,
      priorAsOf: liveData.plan.opening.asOf,
      representedEvents: [{ id: unpaidBill.id, date: UNPAID_BILL_DATE }],
    },
  }), LIVE_AS_OF, LIVE_AS_OF, {}).some(e => e.id === unpaidBill.id),
    'posting evidence on representedEvents does not reserve the $100 again');

  const canonical = clone(liveData);
  canonical.plan = Object.assign({}, canonical.plan, {
    bills: (canonical.plan.bills || []).concat([unpaidBill]),
  });
  const histAsOf = canonical.plan.opening.asOf;
  const control = overlay(clone(liveData), {});
  const result = overlay(canonical, {});
  ok(result.data.liveOverlay && result.data.liveOverlay.applied === true,
    'Aug 21 overlay still applies with an unpaid 20 Aug bill');
  ok(String(result.data.plan.opening.priorAsOf) === String(histAsOf),
    'live opening records the historical as-of as priorAsOf');
  ok(JSON.stringify(result.data.plan.bills) === JSON.stringify(canonical.plan.bills),
    'overlay does not rewrite plan.bills to carry the unpaid occurrence');
  ok(!(result.data.plan.opening.representedEvents || [])
    .some(e => e.id === unpaidBill.id && e.date === UNPAID_BILL_DATE),
    'unpaid intervening bill is not named represented');

  const liveEvents = Forecast.expandEvents(result.data.plan, LIVE_AS_OF, LIVE_AS_OF, {});
  const reserved = liveEvents.find(e => e.id === unpaidBill.id && e.date === UNPAID_BILL_DATE);
  ok(reserved && near(-reserved.amount, UNPAID_INTERVENING),
    'live overlay still emits the unpaid $100 on the live start',
    reserved && String(reserved.amount));
  ok(!Forecast.expandEvents(control.data.plan, LIVE_AS_OF, LIVE_AS_OF, {})
    .some(e => e.id === unpaidBill.id),
    'the control overlay without that bill does not invent it');

  const simOpts = { weeklyVariable: 0, viewDays: 1, horizonDays: 1, targetBuffer: 0 };
  const withBill = Forecast.simulate(result.data.plan, LIVE_AS_OF, simOpts);
  const withoutBill = Forecast.simulate(control.data.plan, LIVE_AS_OF, simOpts);
  ok(withBill.daily && withBill.daily[0] && withoutBill.daily && withoutBill.daily[0],
    'both simulations produce the live as-of day');
  ok(near(withoutBill.daily[0].balance - withBill.daily[0].balance, UNPAID_INTERVENING),
    'first-day close falls by the unpaid $100 by hand, not by a live household cent',
    String(withoutBill.daily[0].balance - withBill.daily[0].balance));
  ok(near(Forecast.startingCashAmount(result.data.plan),
      Forecast.startingCashAmount(control.data.plan)),
    'starting cash is unchanged — the $100 is reserved, not subtracted from the live balance');
  filesUnchanged('intervening unpaid outflow');
}

console.log('\n=== 15. posted child benefit on Chequing B is represented, amount is not identity ===');
{
  const rule = (identity.rules || []).find(r => r && r.eventId === 'childBenefit');
  ok(rule && rule.payeePattern === 'CHILD TAX BEN' && rule.atlasAccountId === 'chequing-b'
    && rule.direction === 'credit',
    'identity rule is CHILD TAX BEN + chequing-b + credit');

  const canonical = clone(liveData);
  const cheqBefore = cashValue(canonical, 'chequing-b');
  const expectedCash = Math.round((cheqBefore + SYNTHETIC_CCB) * 100) / 100;
  const histAsOf = canonical.plan.opening.asOf;
  const ccbTx = {
    id: 91020,
    account_id: 3002,
    date: CCB_AS_OF,
    amount: -SYNTHETIC_CCB,
    payee: 'CHILD TAX BEN CCB',
    is_pending: false,
    status: 'reviewed',
  };
  const result = overlay(canonical, {
    fetchedAt: UNKNOWN_SAME_DAY_AT,
    tweaks: {
      'chequing-b': cheqBefore + SYNTHETIC_CCB,
      cashAt: '2026-08-20T17:55:00.000Z',
    },
    transactions: [ccbTx],
  });
  ok(result.data.liveOverlay && result.data.liveOverlay.applied === true,
    'Aug 20 overlay applies when CHILD TAX BEN CCB is posted on Chequing B');
  ok(String(result.data.meta.asOf) === CCB_AS_OF,
    'in-memory as-of is the child-benefit date');
  ok((result.data.plan.opening.representedEvents || [])
    .some(e => e.id === 'childBenefit' && e.date === CCB_AS_OF),
    'posted child benefit is named on the in-memory live opening');
  ok(near(cashValue(result.data, 'chequing-b'), expectedCash),
    'Chequing B includes the synthetic credit by hand',
    String(cashValue(result.data, 'chequing-b')));
  ok(!Forecast.expandEvents(result.data.plan, CCB_AS_OF, CCB_AS_OF, {})
    .some(e => e.id === 'childBenefit' && e.date === CCB_AS_OF),
    'Forecast does not emit the posted child benefit again on the live as-of');
  ok(Forecast.expandEvents(canonical.plan, histAsOf, CCB_AS_OF, {})
    .some(e => e.id === 'childBenefit' && e.date === CCB_AS_OF),
    'the dated opening would still have emitted that child benefit');

  const observed = O.observe({
    provider: 'lunchmoney',
    payload: payloadFrom(canonical, {
      fetchedAt: UNKNOWN_SAME_DAY_AT,
      tweaks: { cashAt: '2026-08-20T17:55:00.000Z' },
      transactions: [ccbTx],
    }),
    accountMap,
    data: canonical,
    identity,
    fetchedAt: UNKNOWN_SAME_DAY_AT,
  });
  const hit = (observed.representedEventCandidates || [])
    .find(c => c.id === 'childBenefit' && c.date === CCB_AS_OF);
  ok(hit && hit.identity === 'payee+account+date' && hit.amountNotUsed === true,
    'observer identity is payee+account+date, not amount');

  function sameDayKeepsCash(transactions, label) {
    const seen = overlay(clone(liveData), {
      fetchedAt: UNKNOWN_SAME_DAY_AT,
      tweaks: { cashAt: '2026-08-20T17:55:00.000Z' },
      transactions,
    });
    ok(seen.data.liveOverlay.applied === true, label + ' still overlays trusted cash');
    ok(!(seen.data.plan.opening.representedEvents || [])
        .some(row => row.id === 'childBenefit' && row.date === CCB_AS_OF),
      label);
    ok((seen.data.plan.opening.notReliedUponEvents || [])
        .some(row => row.id === 'childBenefit' && row.date === CCB_AS_OF),
      label + ' leaves child benefit unresolved');
  }
  sameDayKeepsCash([{
    id: 91021,
    account_id: 3002,
    date: CCB_AS_OF,
    amount: -SYNTHETIC_CCB,
    payee: 'UNKNOWN DEPOSIT',
    is_pending: false,
    status: 'reviewed',
  }], 'same amount without CHILD TAX BEN payee is not child benefit');
  sameDayKeepsCash([{
    id: 91022,
    account_id: 3001,
    date: CCB_AS_OF,
    amount: -SYNTHETIC_CCB,
    payee: 'CHILD TAX BEN CCB',
    is_pending: false,
    status: 'reviewed',
  }], 'CHILD TAX BEN credit on Chequing A is not child benefit');
  sameDayKeepsCash([{
    id: 91023,
    account_id: 3002,
    date: CCB_AS_OF,
    amount: -SYNTHETIC_CCB,
    payee: 'CHILD TAX BEN CCB',
    is_pending: true,
    status: 'unreviewed',
  }], 'pending CHILD TAX BEN is not posting evidence');
  sameDayKeepsCash([{
    id: 91024,
    account_id: 3002,
    date: CCB_AS_OF,
    amount: SYNTHETIC_CCB,
    payee: 'CHILD TAX BEN CCB',
    is_pending: false,
    status: 'reviewed',
  }], 'CHILD TAX BEN debit is not child benefit');
  sameDayKeepsCash([
    {
      id: 91025,
      account_id: 3002,
      date: CCB_AS_OF,
      amount: -SYNTHETIC_CCB,
      payee: 'CHILD TAX BEN CCB',
      is_pending: false,
      status: 'reviewed',
    },
    {
      id: 91026,
      account_id: 3002,
      date: CCB_AS_OF,
      amount: -40,
      payee: 'CHILD TAX BEN CCB',
      is_pending: false,
      status: 'reviewed',
    },
  ], 'two matching CHILD TAX BEN credits stay fail-closed');
  filesUnchanged('posted child benefit identity');
}

console.log('\n=== 16. fail-closed overlay still reports current observed chequing ===');
{
  const OWNER_A = 217.69;
  const OWNER_B = -591;
  const OWNER_SAVINGS = 0.58;
  const LIMIT = 600;
  const independentNet = Math.round((OWNER_A + OWNER_B) * 100) / 100;
  const independentUsed = Math.max(0, -OWNER_B);
  const independentUnused = Math.max(0, LIMIT - independentUsed);
  const independentAvailable = Math.round(
    (Math.max(0, OWNER_A) + Math.max(0, OWNER_B) + independentUnused) * 100) / 100;
  ok(near(independentNet, -373.31) && near(independentUnused, 9)
      && near(independentAvailable, 226.69),
    'independent owner identity is net −$373.31, unused $9, available $226.69');

  const canonical = clone(liveData);
  const staleA = cashValue(canonical, 'chequing-a');
  const staleB = cashValue(canonical, 'chequing-b');
  const staleSavings = cashValue(canonical, 'savings');
  const staleCash = Forecast.startingCashAmount(canonical.plan);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-live-plan-chequing-'));
  const fixture = path.join(dir, 'fixture.json');
  fs.writeFileSync(fixture, `${JSON.stringify(payloadFrom(canonical, {
    pendingCoverage: null,
    tweaks: {
      'chequing-a': OWNER_A,
      'chequing-b': OWNER_B,
      savings: OWNER_SAVINGS,
    },
  }), null, 2)}\n`);
  const served = Live.serveCanonicalOrFixture(canonical, {
    ATLAS_LIVE_OVERLAY: 'fixture',
    ATLAS_LIVE_OVERLAY_FIXTURE: fixture,
    ATLAS_LIVE_OVERLAY_MAP: MAP,
  });
  ok(served.liveOverlay && served.liveOverlay.applied === false,
    'Forecast overlay still fails closed when pending freshness is unproven');
  ok(near(cashValue(served, 'chequing-a'), staleA)
      && near(cashValue(served, 'chequing-b'), staleB)
      && near(Forecast.startingCashAmount(served.plan), staleCash),
    'fail-closed overlay does not rewrite the Forecast cash opening');
  const observed = served.liveOverlay && served.liveOverlay.observedCash;
  ok(observed && observed.complete === true,
    'freshness-qualified posted cash is still attached as observedCash');
  const observedA = (observed.accounts || []).find(row => row.id === 'chequing-a');
  const observedB = (observed.accounts || []).find(row => row.id === 'chequing-b');
  const observedSavings = (observed.accounts || []).find(row => row.id === 'savings');
  ok(observedA && near(observedA.value, OWNER_A)
      && observedB && near(observedB.value, OWNER_B)
      && observedSavings && near(observedSavings.value, OWNER_SAVINGS),
    'observedCash carries current Chequing A, Chequing B, and Savings');
  const summary = Chequing.chequingAvailability(served.plan, served.revolvingExtra, served.liveOverlay);
  ok(summary.cashSource === 'observed-cash' && near(summary.chequingBalance, independentNet),
    'chequing availability reads observed cash, not the stale opening');
  ok(near(summary.overdraftUsed, independentUsed) && near(summary.overdraftRemaining, independentUnused),
    'unused overdraft is $9, not the full $600 limit');
  ok(near(summary.available, independentAvailable),
    'available in chequing is the independent $226.69 identity',
    String(summary.available));
  ok(!near(summary.available, staleA + staleB + LIMIT),
    'stale $939.04 opening plus $600 cannot produce the headline');
  ok(!near(summary.available, OWNER_A + LIMIT),
    'the full $600 overdraft is not added after $591 has already been consumed');
  ok(!near(summary.available, independentAvailable + OWNER_SAVINGS),
    'savings is excluded from available-in-chequing');
  const util = Forecast.utilisation(served.debts, served.revolvingExtra, served.plan);
  ok(util.totalAvailable > summary.available + 1000,
    'card and HELOC utilisation remain a separate revolving total');
  ok(!near(summary.available, util.totalAvailable)
      && !near(summary.available, independentAvailable + Number((served.debts.find(d => d.id === 'heloc') || {}).limit || 0)),
    'no credit-card or HELOC capacity enters available-in-chequing');
  ok(near(staleA, 629.27) && near(staleB, 309.77) && near(staleSavings, 0.58),
    'canonical opening used as the stale baseline remains the Aug 19 cash rows');
  filesUnchanged('observed chequing on fail-closed overlay');
}

console.log('\n=== 17. posted payday-window mortgage and Fit4less Msp are represented; unknown payee still reserves ===');
{
  const canonical = clone(liveData);
  const scheduledMortgage = Number((canonical.plan.obligations || [])
    .find(row => row && row.id === 'mortgage').amount);
  const scheduledFit = Number((canonical.plan.bills || [])
    .find(row => row && row.id === 'fit4less').amount);
  ok(scheduledMortgage > 0 && scheduledFit > 0,
    'plan still names the biweekly mortgage and Fit4Less amounts');
  ok(!near(SYNTHETIC_MORTGAGE_OBSERVED, scheduledMortgage),
    'observed mortgage debit is deliberately not the scheduled amount');
  ok(!near(SYNTHETIC_FIT_OBSERVED, scheduledFit),
    'observed Fit4Less debit is deliberately not the scheduled amount');

  const mortgageRule = (identity.rules || []).find(r => r && r.eventId === 'mortgage');
  ok(mortgageRule && mortgageRule.payeePattern === 'TD MORTGAGE'
    && mortgageRule.atlasAccountId === 'chequing-a' && mortgageRule.direction === 'debit',
    'mortgage identity is documented TD MORTGAGE + Chequing A debit');
  const fitRule = (identity.rules || []).find(r => r && r.eventId === 'fit4less');
  ok(fitRule && fitRule.payeePattern === 'Fit4less Msp'
    && fitRule.atlasAccountId === 'chequing-a' && fitRule.direction === 'debit',
    'Fit4Less identity is documented Fit4less Msp + Chequing A debit');
  const feeRules = (identity.rules || []).filter(r => r && r.eventId === 'tdfees');
  ok(feeRules.length === 2
      && feeRules.every(r => r.settlesWhen === 'two-leg-sum'
        && r.direction === 'debit'
        && (r.payeePatterns || []).includes('MONTHLY ACCOUNT FEE'))
      && feeRules.some(r => r.atlasAccountId === 'chequing-a')
      && feeRules.some(r => r.atlasAccountId === 'chequing-b'),
    'TD fees use standing two-leg MONTHLY ACCOUNT FEE identity');
  const travelRule = (identity.rules || []).find(r => r && r.eventId === 'travel');
  ok(travelRule && travelRule.atlasAccountId === 'travelvisa'
    && travelRule.direction === 'credit'
    && travelRule.payeePattern === 'TFR-TO C/C'
    && !(travelRule.payeePatterns || []).some(p => /travel visa/i.test(p)),
    'Travel Visa min identity is a payment onto the mapped card, not an invented chequing payee');

  const categories = [
    { id: 21, name: 'Income', is_income: true, exclude_from_totals: false },
    { id: 22, name: 'Mortgage', is_income: false, exclude_from_totals: false },
    { id: 23, name: 'Personal Care', is_income: false, exclude_from_totals: false },
    { id: 24, name: 'Payment/Transfer', is_income: false, exclude_from_totals: true },
  ];
  const window = {
    startDate: '2026-08-16',
    endDate: NEXT_DAY_AS_OF,
    complete: true,
    hasMore: false,
    truncated: false,
  };
  const fitTx = (payee, amount) => ({
    id: 92029,
    account_id: 3001,
    date: PAYDAY_AS_OF,
    amount,
    payee,
    category_id: 23,
    is_pending: false,
    status: 'reviewed',
  });
  const sharedTx = amount => [
    {
      id: 92028,
      account_id: 3001,
      date: PAYDAY_AS_OF,
      amount: -SYNTHETIC_PAYROLL,
      payee: 'SEASPAN PAYROLL',
      category_id: 21,
      is_pending: false,
      status: 'reviewed',
    },
    fitTx('GYM STORE', amount),
    {
      id: 92030,
      account_id: 3001,
      date: PAYDAY_AS_OF,
      amount: SYNTHETIC_TRANSFER,
      payee: 'INTERNAL TRANSFER',
      category_id: 24,
      exclude_from_totals: true,
      is_pending: false,
      status: 'reviewed',
    },
  ];
  const mortgageTx = payee => ({
    id: 92031,
    account_id: 3001,
    date: PAYDAY_AS_OF,
    amount: SYNTHETIC_MORTGAGE_OBSERVED,
    payee,
    category_id: 22,
    is_pending: false,
    status: 'reviewed',
  });
  const extra = (mortgagePayee, fitPayee, fitAmount) => {
    const amt = fitAmount != null ? fitAmount : scheduledFit;
    const txs = sharedTx(amt).map(tx => (
      tx.id === 92029 ? fitTx(fitPayee || 'GYM STORE', amt) : tx
    ));
    return {
      fetchedAt: NEXT_DAY_AT,
      categories,
      transactionWindow: window,
      tweaks: {
        'chequing-a': cashValue(canonical, 'chequing-a')
          + SYNTHETIC_PAYROLL - SYNTHETIC_MORTGAGE_OBSERVED - amt - SYNTHETIC_TRANSFER,
        cashAt: '2026-08-29T17:55:00.000Z',
      },
      transactions: txs.concat([mortgageTx(mortgagePayee)]),
    };
  };

  const control = overlay(clone(canonical), extra('UNKNOWN MORTGAGE PAYEE', 'GYM STORE', scheduledFit));
  const result = overlay(clone(canonical), extra('TD MORTGAGE', 'GYM STORE', scheduledFit));
  const identified = overlay(clone(canonical), extra('TD MORTGAGE', 'Fit4less Msp', SYNTHETIC_FIT_OBSERVED));
  ok(control.data.liveOverlay && control.data.liveOverlay.applied === true,
    'control overlay still applies without guessing the mortgage');
  ok(result.data.liveOverlay && result.data.liveOverlay.applied === true,
    'Aug 29 overlay applies when TD MORTGAGE is identified');
  ok(identified.data.liveOverlay && identified.data.liveOverlay.applied === true,
    'Aug 29 overlay applies when Fit4less Msp is identified');
  ok(String(result.data.meta.asOf) === NEXT_DAY_AS_OF,
    'in-memory as-of is the day after payday');
  ok(!(result.report.currentPeriodActuals.transactions || [])
      .some(tx => tx && tx.date === NEXT_DAY_AS_OF),
    'fixture has no transactions dated 2026-08-29');

  const mortgageHit = (result.report.representedEventCandidates || [])
    .find(c => c.id === 'mortgage' && c.date === PAYDAY_AS_OF);
  ok(mortgageHit && mortgageHit.identity === 'payee+account+date'
    && mortgageHit.amountNotUsed === true
    && near(mortgageHit.observedAmount, SYNTHETIC_MORTGAGE_OBSERVED),
    'mortgage identity is payee+account+date, not the scheduled $ amount');
  ok(!(control.report.representedEventCandidates || [])
      .some(c => c.id === 'mortgage'),
    'amount and Mortgage category without TD MORTGAGE is not identity');
  ok((result.data.plan.opening.representedEvents || [])
      .some(e => e.id === 'mortgage' && e.date === PAYDAY_AS_OF),
    'posted payday-window mortgage is named on the in-memory opening');
  ok(!(result.data.plan.opening.representedEvents || [])
      .some(e => e.id === 'fit4less'),
    'Personal Care amount is not invented into Fit4Less representation');

  const fitHit = (identified.report.representedEventCandidates || [])
    .find(c => c.id === 'fit4less' && c.date === PAYDAY_AS_OF);
  ok(fitHit && fitHit.identity === 'payee+account+date'
    && fitHit.amountNotUsed === true
    && near(fitHit.observedAmount, SYNTHETIC_FIT_OBSERVED),
    'Fit4Less identity is payee+account+date, not the scheduled $ amount');
  ok((identified.data.plan.opening.representedEvents || [])
      .some(e => e.id === 'fit4less' && e.date === PAYDAY_AS_OF),
    'posted Friday Fit4less Msp is named on the in-memory opening');

  const payrollHits = (result.data.plan.opening.representedEvents || [])
    .filter(e => e.id === 'payroll' && e.date === PAYDAY_AS_OF);
  ok(payrollHits.length === 1,
    'Aug 28 payroll is represented once and not replayed onto representedEvents');
  ok(!Forecast.expandEvents(result.data.plan, NEXT_DAY_AS_OF, NEXT_DAY_AS_OF, {})
      .some(e => e.id === 'payroll' && e.date === PAYDAY_AS_OF),
    'Forecast does not emit the posted Aug 28 payroll again');
  ok(Forecast.expandEvents(canonical.plan, canonical.plan.opening.asOf, PAYDAY_AS_OF, {})
      .some(e => e.id === 'payroll' && e.date === PAYDAY_AS_OF),
    'the dated opening would still emit that payroll');

  ok(!Forecast.expandEvents(result.data.plan, NEXT_DAY_AS_OF, NEXT_DAY_AS_OF, {})
      .some(e => e.id === 'mortgage' && e.date === PAYDAY_AS_OF),
    'Forecast does not reserve the posted mortgage again');
  ok(Forecast.expandEvents(control.data.plan, NEXT_DAY_AS_OF, NEXT_DAY_AS_OF, {})
      .some(e => e.id === 'mortgage' && e.date === PAYDAY_AS_OF),
    'without TD MORTGAGE identity the mortgage remains reserved');
  const controlReserved = Forecast.expandEvents(control.data.plan, NEXT_DAY_AS_OF, NEXT_DAY_AS_OF, {})
    .find(e => e.id === 'mortgage' && e.date === PAYDAY_AS_OF);
  ok(controlReserved && near(-controlReserved.amount, scheduledMortgage),
    'independent reserved amount is the plan mortgage row, not the observed debit');

  const fitReserved = Forecast.expandEvents(result.data.plan, NEXT_DAY_AS_OF, NEXT_DAY_AS_OF, {})
    .find(e => e.id === 'fit4less' && e.date === PAYDAY_AS_OF);
  ok(fitReserved && near(-fitReserved.amount, scheduledFit),
    'unknown Fit4Less payee still reserves the gym membership');
  ok(!Forecast.expandEvents(identified.data.plan, NEXT_DAY_AS_OF, NEXT_DAY_AS_OF, {})
      .some(e => e.id === 'fit4less' && e.date === PAYDAY_AS_OF),
    'Fit4less Msp leaves the gym membership reserved');

  const advice = Forecast.recommend(result.data.plan, NEXT_DAY_AS_OF, {
    currentPeriodActuals: result.data.liveOverlay.currentPeriodActuals,
    debts: result.data.debts,
    revolvingExtra: result.data.revolvingExtra,
    targetBuffer: canonical.plan.defaults.targetBuffer,
  });
  const controlAdvice = Forecast.recommend(control.data.plan, NEXT_DAY_AS_OF, {
    currentPeriodActuals: control.data.liveOverlay.currentPeriodActuals,
    debts: control.data.debts,
    revolvingExtra: control.data.revolvingExtra,
    targetBuffer: canonical.plan.defaults.targetBuffer,
  });
  const identifiedAdvice = Forecast.recommend(identified.data.plan, NEXT_DAY_AS_OF, {
    currentPeriodActuals: identified.data.liveOverlay.currentPeriodActuals,
    debts: identified.data.debts,
    revolvingExtra: identified.data.revolvingExtra,
    targetBuffer: canonical.plan.defaults.targetBuffer,
  });
  const items = (advice.paydayAllocation && advice.paydayAllocation.obligations
    && advice.paydayAllocation.obligations.items) || [];
  const controlItems = (controlAdvice.paydayAllocation
    && controlAdvice.paydayAllocation.obligations
    && controlAdvice.paydayAllocation.obligations.items) || [];
  const identifiedItems = (identifiedAdvice.paydayAllocation
    && identifiedAdvice.paydayAllocation.obligations
    && identifiedAdvice.paydayAllocation.obligations.items) || [];
  ok(!items.some(row => row.id === 'mortgage' && row.date === PAYDAY_AS_OF),
    'paydayAllocation does not treat the posted mortgage as still due');
  ok(controlItems.some(row => row.id === 'mortgage' && row.date === PAYDAY_AS_OF
      && row.settlement === 'unverified'),
    'control still lists the unidentified mortgage as unverified');
  ok(items.some(row => row.id === 'fit4less' && row.date === PAYDAY_AS_OF
      && row.settlement === 'unverified'),
    'unknown Fit4Less payee stays reserved');
  ok(!identifiedItems.some(row => row.id === 'fit4less' && row.date === PAYDAY_AS_OF),
    'Fit4less Msp does not keep the gym membership reserved');
  ok(identifiedItems.some(row => row.id === 'travel' || row.label === 'Travel Visa minimum')
    || identifiedItems.some(row => row.id === 'tdfees'),
    'Travel Visa and/or TD fees can remain reserved without an invented identity');
  ok(near(
    controlAdvice.paydayAllocation.obligations.wanted - advice.paydayAllocation.obligations.wanted,
    scheduledMortgage
  ), 'independent wanted delta is the scheduled mortgage, not the observed debit');
  ok(near(
    advice.paydayAllocation.obligations.wanted - identifiedAdvice.paydayAllocation.obligations.wanted,
    scheduledFit
  ), 'independent Fit4Less wanted delta is the scheduled gym amount, not the observed debit');

  const bills = (advice.currentPeriodAction && advice.currentPeriodAction.bills) || [];
  const identifiedBills = (identifiedAdvice.currentPeriodAction
    && identifiedAdvice.currentPeriodAction.bills) || [];
  const identifiedInflows = (identifiedAdvice.currentPeriodAction
    && identifiedAdvice.currentPeriodAction.inflows) || [];
  ok(bills.some(row => row.id === 'mortgage' && row.settlement === 'represented'
      && near(row.actual, SYNTHETIC_MORTGAGE_OBSERVED)),
    'currentPeriodAction names the mortgage represented with the observed actual');
  ok(bills.some(row => row.id === 'fit4less' && row.settlement === 'unverified'),
    'unknown Fit4Less payee stays unverified on currentPeriodAction');
  ok(identifiedBills.some(row => row.id === 'fit4less' && row.settlement === 'represented'
      && near(row.actual, SYNTHETIC_FIT_OBSERVED)),
    'Fit4less Msp is already paid with the observed actual, not the scheduled amount');
  ok(identifiedInflows.some(row => row.id === 'payroll' && row.date === PAYDAY_AS_OF),
    'represented Friday Seaspan is an inflow on currentPeriodAction');

  const transferActual = (result.report.currentPeriodActuals.transactions || [])
    .find(tx => tx && tx.date === PAYDAY_AS_OF && near(tx.amount, SYNTHETIC_TRANSFER));
  ok(transferActual && transferActual.excludeFromTotals === true
      && transferActual.accountRole === 'household-cash',
    'Aug 28 Payment/Transfer excludeFromTotals is observed household-cash');
  const unmatched = (result.report.obligationReconciliationReceipt
    && result.report.obligationReconciliationReceipt.unmatchedCashEvidence) || [];
  ok(!unmatched.some(row => near(row.amount, SYNTHETIC_TRANSFER)),
    'excludeFromTotals transfer is not unmatched household cash');
  ok(result.writesCanonicalState === false
      && result.data.liveOverlay.writesCanonicalState === false,
    'live overlay still does not write canonical state');
  const preview = C.buildPreview(result.report, { data: canonical });
  ok(!(preview.proposed || []).some(row => near(row.proposedValue, SYNTHETIC_TRANSFER)
      || near(row.currentValue, SYNTHETIC_TRANSFER)),
    'canonical preview does not write the unmatched $ transfer');
  ok(!(preview.unresolved || []).some(row =>
      row.reason === 'unmatched-household-cash-must-not-write'
      && near(row.amount, SYNTHETIC_TRANSFER)),
    'excludeFromTotals transfer does not become an unmatched write row');
  ok((preview.ownerQuestions || []).some(row => row.id === 'fit4less'
      && row.reason === 'unverified-settlement-owner-fact'),
    'unknown Fit4Less payee remains an unverified-settlement owner question');
  ok(!(preview.ownerQuestions || []).some(row => row.id === 'mortgage'),
    'represented mortgage is not an owner settlement question');
  const identifiedPreview = C.buildPreview(identified.report, { data: canonical });
  ok(!(identifiedPreview.ownerQuestions || []).some(row => row.id === 'fit4less'),
    'Fit4less Msp is not an owner settlement question');
  const question = result.data.refreshTrust && result.data.refreshTrust.ownerQuestion;
  ok(question && question.reason === 'unverified-settlement-owner-fact',
    'refresh-trust still surfaces the unverified-settlement owner-fact gate',
    question && `${question.id} ${question.reason}`);
  filesUnchanged('posted payday-window mortgage');
}

console.log('\n=== 18. complete live cash plus missing same-day unposted bill still overlays ===');
{
  const FEE_DAY_AT = '2026-08-30T18:00:00.000Z';
  const FEE_DAY_AS_OF = '2026-08-30';
  const SYNTHETIC_LIVE_A = 410.11;
  const SYNTHETIC_LIVE_B = -80.07;
  const SYNTHETIC_LIVE_SAVINGS = 1.33;
  const independentLeftover = Math.round(
    (SYNTHETIC_LIVE_A + SYNTHETIC_LIVE_B) * 100
  ) / 100;
  const canonical = clone(liveData);
  const openingCash = Forecast.startingCashAmount(canonical.plan);
  const scheduledFees = Number((canonical.plan.bills || [])
    .find(row => row && row.id === 'tdfees').amount);
  ok(scheduledFees > 0, 'plan still names the month-end TD fees amount');
  const feeRules = (identity.rules || []).filter(r => r && r.eventId === 'tdfees');
  ok(feeRules.length === 2
      && feeRules.every(r => r.settlesWhen === 'two-leg-sum'
        && r.direction === 'debit'
        && (r.payeePatterns || []).includes('MONTHLY ACCOUNT FEE'))
      && feeRules.some(r => r.atlasAccountId === 'chequing-a')
      && feeRules.some(r => r.atlasAccountId === 'chequing-b'),
    'TD fees use standing two-leg MONTHLY ACCOUNT FEE identity');
  const travelRule = (identity.rules || []).find(r => r && r.eventId === 'travel');
  ok(travelRule && travelRule.atlasAccountId === 'travelvisa'
    && travelRule.direction === 'credit'
    && travelRule.payeePattern === 'TFR-TO C/C'
    && !(travelRule.payeePatterns || []).some(p => /travel visa/i.test(p)),
    'Travel Visa min identity is a payment onto the mapped card, not an invented chequing payee');
  ok(!near(independentLeftover, openingCash),
    'synthetic live cash is not the dated opening leftover');

  const paydayTxs = [
    {
      id: 93028,
      account_id: 3001,
      date: PAYDAY_AS_OF,
      amount: -SYNTHETIC_PAYROLL,
      payee: 'SEASPAN PAYROLL',
      category_id: 21,
      is_pending: false,
      status: 'reviewed',
    },
    {
      id: 93029,
      account_id: 3001,
      date: PAYDAY_AS_OF,
      amount: SYNTHETIC_MORTGAGE_OBSERVED,
      payee: 'TD MORTGAGE',
      category_id: 22,
      is_pending: false,
      status: 'reviewed',
    },
    {
      id: 93030,
      account_id: 3001,
      date: PAYDAY_AS_OF,
      amount: SYNTHETIC_FIT_OBSERVED,
      payee: 'Fit4less Msp',
      category_id: 23,
      is_pending: false,
      status: 'reviewed',
    },
  ];
  const extra = {
    fetchedAt: FEE_DAY_AT,
    categories: [
      { id: 21, name: 'Income', is_income: true, exclude_from_totals: false },
      { id: 22, name: 'Mortgage', is_income: false, exclude_from_totals: false },
      { id: 23, name: 'Personal Care', is_income: false, exclude_from_totals: false },
    ],
    transactionWindow: {
      startDate: '2026-08-16',
      endDate: FEE_DAY_AS_OF,
      complete: true,
      hasMore: false,
      truncated: false,
    },
    tweaks: {
      'chequing-a': SYNTHETIC_LIVE_A,
      'chequing-b': SYNTHETIC_LIVE_B,
      savings: SYNTHETIC_LIVE_SAVINGS,
      cashAt: '2026-08-30T17:55:00.000Z',
    },
    transactions: paydayTxs,
  };

  const result = overlay(clone(canonical), extra);
  ok(result.data.liveOverlay && result.data.liveOverlay.applied === true,
    'Aug 30 overlay applies when Friday payday is represented and TD fees are unposted');
  ok(String(result.data.meta.asOf) === FEE_DAY_AS_OF,
    'in-memory as-of is the morning household date');
  const represented = result.data.plan.opening.representedEvents || [];
  ok(represented.length > 0, 'representedEvents are not emptied by the unposted same-day bill');
  ok(represented.some(e => e.id === 'payroll' && e.date === PAYDAY_AS_OF),
    'Friday Seaspan stays represented');
  ok(represented.some(e => e.id === 'mortgage' && e.date === PAYDAY_AS_OF),
    'Friday mortgage stays represented');
  ok(represented.some(e => e.id === 'fit4less' && e.date === PAYDAY_AS_OF),
    'Friday Fit4Less stays represented');
  ok(!represented.some(e => e.id === 'tdfees'),
    'unposted TD fees are not invented onto representedEvents');
  ok(!represented.some(e => e.id === 'travel'),
    'Travel Visa is not invented onto representedEvents');

  ok(near(cashValue(result.data, 'chequing-a'), SYNTHETIC_LIVE_A)
      && near(cashValue(result.data, 'chequing-b'), SYNTHETIC_LIVE_B)
      && near(cashValue(result.data, 'savings'), SYNTHETIC_LIVE_SAVINGS),
    'posted cash overlays the complete live observation');
  const liveCash = Forecast.startingCashAmount(result.data.plan);
  ok(near(liveCash, independentLeftover),
    'leftover cash is the independent live chequing sum',
    String(liveCash));
  ok(!near(liveCash, openingCash),
    'leftover cash is not the dated opening');

  ok(Forecast.expandEvents(result.data.plan, FEE_DAY_AS_OF, FEE_DAY_AS_OF, {})
      .some(e => e.id === 'tdfees' && e.date === FEE_DAY_AS_OF),
    'Forecast still emits unposted TD fees on the live as-of');
  ok(!Forecast.expandEvents(result.data.plan, FEE_DAY_AS_OF, FEE_DAY_AS_OF, {})
      .some(e => e.id === 'payroll' && e.date === PAYDAY_AS_OF),
    'Forecast does not replay Friday Seaspan onto the live as-of');

  const advice = Forecast.recommend(result.data.plan, FEE_DAY_AS_OF, {
    currentPeriodActuals: result.data.liveOverlay.currentPeriodActuals,
    debts: result.data.debts,
    revolvingExtra: result.data.revolvingExtra,
    targetBuffer: canonical.plan.defaults.targetBuffer,
  });
  // Without the owner's card-coverage rule the unconfirmed opening withholds;
  // with the canonical rule (opening 2026-11-06, after this fixture) every
  // card row here is existing card debt and coverage holds nothing.
  const noRulePlan = { ...result.data.plan };
  delete noRulePlan.cardPurchaseCoverage;
  const noRule = Forecast.recommend(noRulePlan, FEE_DAY_AS_OF, {
    currentPeriodActuals: result.data.liveOverlay.currentPeriodActuals,
    debts: result.data.debts,
    revolvingExtra: result.data.revolvingExtra,
    targetBuffer: canonical.plan.defaults.targetBuffer,
  });
  ok(near(Forecast.startingCashAmount(result.data.plan), independentLeftover)
      && noRule.paydayAllocation.available === null && noRule.cardCoverageUnavailable === true,
    'observed cash is unchanged; unknown card coverage withholds usable payday money');
  ok(advice.cardPurchaseCoverage?.status === 'ready' && advice.cardPurchaseCoverage.reservedCash === 0,
    'before the canonical coverage opening, card activity is existing debt: no coverage hold',
    JSON.stringify(advice.cardPurchaseCoverage?.issues));
  const due = (advice.currentPeriodAction && advice.currentPeriodAction.thisPaydayDue) || [];
  const paid = (advice.currentPeriodAction && advice.currentPeriodAction.thisPaydayPaid) || {};
  ok(due.some(row => row.id === 'tdfees' && row.date === FEE_DAY_AS_OF),
    'still due can list TD fees');
  ok(due.some(row => row.id === 'travel' || /Travel Visa/i.test(String(row.label || ''))),
    'Travel Visa min stays still due with no invented payee');
  ok((paid.inflows || []).some(row => row.id === 'payroll' && row.date === PAYDAY_AS_OF),
    'already paid keeps Friday Seaspan in');
  ok((paid.bills || []).some(row => row.id === 'mortgage' && row.date === PAYDAY_AS_OF),
    'already paid keeps Friday mortgage');
  ok((paid.bills || []).some(row => row.id === 'fit4less' && row.date === PAYDAY_AS_OF),
    'already paid keeps Friday Fit4Less');
  const actuals = result.data.liveOverlay.currentPeriodActuals;
  ok(actuals && Array.isArray(actuals.transactions) && actuals.transactions.length > 0,
    'applied overlay keeps current-period actuals');
  ok(!(result.report.representedEventCandidates || []).some(c => c.id === 'tdfees'),
    'observer does not invent a TD fees candidate');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-live-plan-fees-'));
  const fixture = path.join(dir, 'fixture.json');
  fs.writeFileSync(fixture, `${JSON.stringify(payloadFrom(canonical, extra), null, 2)}\n`);
  const served = Live.serveCanonicalOrFixture(canonical, {
    ATLAS_LIVE_OVERLAY: 'fixture',
    ATLAS_LIVE_OVERLAY_FIXTURE: fixture,
    ATLAS_LIVE_OVERLAY_MAP: MAP,
  });
  ok(served.liveOverlay && served.liveOverlay.applied === true,
    'server overlay still applies on the unposted same-day bill');
  ok((served.plan.opening.representedEvents || []).length > 0,
    'server representedEvents are not emptied');
  ok(near(Forecast.startingCashAmount(served.plan), independentLeftover),
    'served leftover stays the live chequing sum');

  const withUnknownIncome = clone(canonical);
  withUnknownIncome.plan = Object.assign({}, withUnknownIncome.plan, {
    income: (withUnknownIncome.plan.income || []).concat([{
      id: 'same-day-unknown-income',
      label: 'Synthetic same-day income',
      frequency: 'once',
      date: FEE_DAY_AS_OF,
      amount: 50,
      confidence: 'confirmed',
    }]),
  });
  const unknownIncome = overlay(withUnknownIncome, extra);
  ok(unknownIncome.data.liveOverlay.applied === true,
    'unknown same-day income does not refuse a complete live-cash overlay');
  ok((unknownIncome.data.plan.opening.notReliedUponEvents || [])
      .some(row => row.id === 'same-day-unknown-income' && row.date === FEE_DAY_AS_OF),
    'synthetic same-day income is not-relied-upon');
  ok(!(unknownIncome.data.plan.opening.representedEvents || [])
      .some(row => row.id === 'same-day-unknown-income'),
    'synthetic same-day income is not labelled represented');
  ok(near(Forecast.startingCashAmount(unknownIncome.data.plan), independentLeftover),
    'unresolved same-day income does not discard the live chequing sum');
  filesUnchanged('unposted same-day bill overlay');
}

console.log('\n=== 19. card and chequing payment movements leave minimum intent unconfirmed ===');
{
  const SYNTHETIC_CARD_PAY = 40.4;
  const SYNTHETIC_SHORT = 5.05;
  const canonical = clone(liveData);
  const scheduledTravel = Number((canonical.plan.obligations || [])
    .find(row => row && row.id === 'travel').amount);
  ok(scheduledTravel > 0, 'plan still names the Travel Visa minimum');
  ok(SYNTHETIC_CARD_PAY + 0.005 >= scheduledTravel && !near(SYNTHETIC_CARD_PAY, scheduledTravel),
    'identified extra payment covers the min and is not the scheduled $');
  ok(SYNTHETIC_SHORT + 0.005 < scheduledTravel,
    'short card credit is independently below the min');

  const paydayTxs = [
    {
      id: 94028, account_id: 3001, date: PAYDAY_AS_OF, amount: -SYNTHETIC_PAYROLL,
      payee: 'SEASPAN PAYROLL', category_id: 21, is_pending: false, status: 'reviewed',
    },
    {
      id: 94029, account_id: 3001, date: PAYDAY_AS_OF, amount: SYNTHETIC_MORTGAGE_OBSERVED,
      payee: 'TD MORTGAGE', category_id: 22, is_pending: false, status: 'reviewed',
    },
    {
      id: 94030, account_id: 3001, date: PAYDAY_AS_OF, amount: SYNTHETIC_FIT_OBSERVED,
      payee: 'Fit4less Msp', category_id: 23, is_pending: false, status: 'reviewed',
    },
  ];
  const window = {
    startDate: '2026-08-16',
    endDate: NEXT_DAY_AS_OF,
    complete: true,
    hasMore: false,
    truncated: false,
  };
  const categories = [
    { id: 21, name: 'Income', is_income: true, exclude_from_totals: false },
    { id: 22, name: 'Mortgage', is_income: false, exclude_from_totals: false },
    { id: 23, name: 'Personal Care', is_income: false, exclude_from_totals: false },
    { id: 24, name: 'Payment/Transfer', is_income: false, exclude_from_totals: true },
  ];
  const extraFor = (cardTx) => ({
    fetchedAt: NEXT_DAY_AT,
    categories,
    transactionWindow: window,
    tweaks: {
      'chequing-a': cashValue(canonical, 'chequing-a')
        + SYNTHETIC_PAYROLL - SYNTHETIC_MORTGAGE_OBSERVED - SYNTHETIC_FIT_OBSERVED,
      cashAt: '2026-08-29T17:55:00.000Z',
    },
    transactions: paydayTxs.concat(cardTx || []),
  });

  const chequingOnly = overlay(clone(canonical), extraFor([{
    id: 94031, account_id: 3001, date: PAYDAY_AS_OF, amount: SYNTHETIC_CARD_PAY,
    payee: 'TFR-TO C/C', category_id: 24, exclude_from_totals: true,
    is_pending: false, status: 'reviewed',
  }]));
  const shortCard = overlay(clone(canonical), extraFor([{
    id: 94032, account_id: 3006, date: PAYDAY_AS_OF, amount: -SYNTHETIC_SHORT,
    payee: 'TFR-TO C/C', is_pending: false, status: 'reviewed',
  }]));
  const identified = overlay(clone(canonical), extraFor([{
    id: 94033, account_id: 3006, date: PAYDAY_AS_OF, amount: -SYNTHETIC_CARD_PAY,
    payee: 'TFR-TO C/C', is_pending: false, status: 'reviewed',
  }]));

  ok(chequingOnly.data.liveOverlay && chequingOnly.data.liveOverlay.applied === true,
    'chequing TFR-TO C/C overlay still applies');
  ok(identified.data.liveOverlay && identified.data.liveOverlay.applied === true,
    'card-account extra payment overlay applies');
  ok(!(chequingOnly.report.representedEventCandidates || []).some(c => c.id === 'travel'),
    'TFR-TO C/C leaving chequing is not Travel Visa identity');
  ok(!(shortCard.report.representedEventCandidates || []).some(c => c.id === 'travel'),
    'identified card credit below the min does not settle it');
  const hit = (identified.report.representedEventCandidates || [])
    .find(c => c.id === 'travel');
  ok(!hit, 'Travel Visa credit proves a movement, not minimum-payment intent');
  ok(!(identified.data.plan.opening.representedEvents || [])
      .some(e => e.id === 'travel' && e.date === '2026-08-26'),
    'in-memory opening does not name an unconfirmed card minimum');

  const advice = Forecast.recommend(identified.data.plan, NEXT_DAY_AS_OF, {
    currentPeriodActuals: identified.data.liveOverlay.currentPeriodActuals,
    debts: identified.data.debts,
    revolvingExtra: identified.data.revolvingExtra,
    targetBuffer: canonical.plan.defaults.targetBuffer,
  });
  const controlAdvice = Forecast.recommend(chequingOnly.data.plan, NEXT_DAY_AS_OF, {
    currentPeriodActuals: chequingOnly.data.liveOverlay.currentPeriodActuals,
    debts: chequingOnly.data.debts,
    revolvingExtra: chequingOnly.data.revolvingExtra,
    targetBuffer: canonical.plan.defaults.targetBuffer,
  });
  const paid = (advice.currentPeriodAction && advice.currentPeriodAction.thisPaydayPaid) || {};
  const due = (advice.currentPeriodAction && advice.currentPeriodAction.thisPaydayDue) || [];
  const controlDue = (controlAdvice.currentPeriodAction
    && controlAdvice.currentPeriodAction.thisPaydayDue) || [];
  ok(!(paid.bills || []).some(row => row.id === 'travel' && row.date === PAYDAY_AS_OF
      && near(row.movement, -SYNTHETIC_CARD_PAY)),
    'already paid this payday does not relabel a backfill as a minimum payment');
  ok(due.some(row => row.id === 'travel'),
    'Travel Visa minimum remains unconfirmed');
  ok(controlDue.some(row => row.id === 'travel'),
    'chequing TFR-TO C/C leaves the min still due');
  ok(due.some(row => row.id === 'tdfees') || controlDue.some(row => row.id === 'tdfees'),
    'TD fees are not invented away');
  filesUnchanged('extra payment onto mapped card');
}

function independentSeaspanCycle(asOf) {
  // Independent of Forecast.spendingCycle: 14-day steps from Friday 2026-08-14.
  const dayMs = 24 * 60 * 60 * 1000;
  const asOfMs = Date.parse(asOf + 'T00:00:00Z');
  let startMs = Date.parse('2026-08-14T00:00:00Z');
  while (startMs + 14 * dayMs <= asOfMs) startMs += 14 * dayMs;
  while (startMs > asOfMs) startMs -= 14 * dayMs;
  const nextMs = startMs + 14 * dayMs;
  const iso = ms => new Date(ms).toISOString().slice(0, 10);
  return { start: iso(startMs), end: iso(nextMs - dayMs), nextPayday: iso(nextMs) };
}

function activeCalendarPeriod(advice) {
  const view = advice && advice.defaultView;
  const periods = (view && view.calendarPeriods) || [];
  return periods.find(p => p && p.role === 'active') || null;
}

function serveFixtureOverlay(canonical, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-live-plan-asof-'));
  const fixture = path.join(dir, 'fixture.json');
  fs.writeFileSync(fixture, `${JSON.stringify(payloadFrom(canonical, extra), null, 2)}\n`);
  return Live.serveCanonicalOrFixture(canonical, {
    ATLAS_LIVE_OVERLAY: 'fixture',
    ATLAS_LIVE_OVERLAY_FIXTURE: fixture,
    ATLAS_LIVE_OVERLAY_MAP: MAP,
  });
}

function independentMonthDate(year, month, day) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const d = Math.min(Number(day), last);
  return `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function independentBiweeklyDates(anchor, after, through) {
  const dates = [];
  if (!anchor) return dates;
  let t = Date.parse(anchor + 'T12:00:00Z');
  const end = Date.parse(through + 'T12:00:00Z');
  const start = Date.parse(after + 'T12:00:00Z');
  const step = 14 * 86400000;
  if (!isFinite(t) || !isFinite(end) || !isFinite(start)) return dates;
  while (t <= end) {
    if (t > start) dates.push(new Date(t).toISOString().slice(0, 10));
    t += step;
  }
  return dates;
}

function independentLaterIncome(plan, openingAsOf, through) {
  const rows = [];
  const year = Number(openingAsOf.slice(0, 4));
  const month = Number(openingAsOf.slice(5, 7));
  for (const stream of (plan && plan.income) || []) {
    if (!stream) continue;
    if (stream.frequency === 'monthly' && stream.day != null) {
      const date = independentMonthDate(year, month, stream.day);
      if (stream.firstDue && date < stream.firstDue) continue;
      if (date > openingAsOf && date <= through) {
        rows.push({
          id: stream.id,
          label: stream.label,
          date,
          amount: Math.round((Number(stream.amount) || 0) * 100) / 100,
        });
      }
    } else if (stream.frequency === 'biweekly') {
      for (const date of independentBiweeklyDates(stream.anchor, openingAsOf, through)) {
        rows.push({
          id: stream.id,
          label: stream.label,
          date,
          amount: Math.round((Number(stream.amount) || 0) * 100) / 100,
        });
      }
    }
  }
  return rows;
}

function independentDatedCash(plan) {
  const rows = (plan && plan.startingCash && plan.startingCash.breakdown) || [];
  return Math.round(rows.reduce((s, r) => s + (Number(r && r.value) || 0), 0) * 100) / 100;
}

function independentChequingCash(plan) {
  return Math.round(independentSpendableOpening(plan) * 100) / 100;
}

function money2en(n) {
  return '$' + Math.abs(Number(n)).toLocaleString('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function observedCashNet(packet) {
  const accounts = packet && packet.accounts;
  if (!Array.isArray(accounts) || !accounts.length) return null;
  return Math.round(accounts.reduce((s, r) => s + (Number(r && r.value) || 0), 0) * 100) / 100;
}

function calendarWaterfallComposer() {
  const appSrc = sourceText(fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'));
  const planSrc = sourceText(fs.readFileSync(path.join(ROOT, 'public', 'plan.js'), 'utf8'));
  const grab = (src, re, label) => {
    const m = re.exec(src);
    if (!m) throw new Error('missing ' + label);
    return m[0];
  };
  return vm.runInNewContext([
    grab(appSrc, /^const money = .*$/m, 'money'),
    grab(appSrc, /^const money2 = .*$/m, 'money2'),
    grab(appSrc, /^const escapeHtml = .*$/m, 'escapeHtml'),
    grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
    grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
    grab(planSrc, /^function liveOperatingPlanUnavailable\([\s\S]*?\n\}$/m, 'liveOperatingPlanUnavailable'),
    grab(planSrc, /^function liveOperatingPlanNote\([\s\S]*?\n\}$/m, 'liveOperatingPlanNote'),
    grab(planSrc, /^function paydayGlanceCashNote\([\s\S]*?\n\}$/m, 'paydayGlanceCashNote'),
    grab(planSrc, /^function providerBalanceDate\([\s\S]*?\n\}$/m, 'providerBalanceDate'),
    grab(planSrc, /^function glanceUpdatedNote\([\s\S]*?\n\}$/m, 'glanceUpdatedNote'),
    grab(planSrc, /^function cashGlanceHtml\([\s\S]*?\n\}$/m, 'cashGlanceHtml'),
    grab(planSrc, /^function liveCurrentBalanceHtml\([\s\S]*?\n\}$/m, 'liveCurrentBalanceHtml'),
    grab(planSrc, /^function glanceSignedMoney\([\s\S]*?\n\}$/m, 'glanceSignedMoney'),
    grab(planSrc, /^function glanceMoney\([\s\S]*?\n\}$/m, 'glanceMoney'),
    grab(planSrc, /^function glanceLineLabel\([\s\S]*?\n\}$/m, 'glanceLineLabel'),
    grab(planSrc, /^function runningLeftoverHtml\([\s\S]*?\n\}$/m, 'runningLeftoverHtml'),
    grab(planSrc, /^function periodBillLine\([\s\S]*?\n\}$/m, 'periodBillLine'),
    grab(planSrc, /^function calendarCurrentUnavailableHtml\([\s\S]*?\n\}$/m, 'calendarCurrentUnavailableHtml'),
    grab(planSrc, /^function calendarIncomeHtml\([\s\S]*?\n\}$/m, 'calendarIncomeHtml'),
    grab(planSrc, /^function paydayBucketRow\([\s\S]*?\n\}$/m, 'paydayBucketRow'),
    grab(planSrc, /^function householdBudgetCycleText\([\s\S]*?\n\}$/m, 'householdBudgetCycleText'),
    grab(planSrc, /^function householdBudgetMetric\([\s\S]*?\n\}$/m, 'householdBudgetMetric'),
    grab(planSrc, /^function householdBudgetCategoryHtml\([\s\S]*?\n\}$/m, 'householdBudgetCategoryHtml'),
    grab(planSrc, /^function calendarBudgetHtml\([\s\S]*?\n\}$/m, 'calendarBudgetHtml'),
    grab(planSrc, /^function calendarPeriodBillsHtml\([\s\S]*?\n\}$/m, 'calendarPeriodBillsHtml'),
    grab(planSrc, /^function extraRepaymentHtml\([\s\S]*?\n\}$/m, 'extraRepaymentHtml'),
    grab(planSrc, /^function firstCardHtml\([\s\S]*?\n\}$/m, 'firstCardHtml'),
    grab(planSrc, /^function otherCardsHtml\([\s\S]*?\n\}$/m, 'otherCardsHtml'),
    grab(planSrc, /^function bigPurchasesHtml\([\s\S]*?\n\}$/m, 'bigPurchasesHtml'),
    grab(planSrc, /^function calendarFromTodayEvidenceHtml\([\s\S]*?\n\}$/m, 'calendarFromTodayEvidenceHtml'),
    grab(planSrc, /^function calendarWaterfallHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallHtml'),
    '({ calendarWaterfallHtml, glanceUpdatedNote, cashGlanceHtml, money2 })',
  ].join('\n'), { Forecast, state: { scenario: null, targetBuffer: 500, extraDebtMonthly: 0, incomeOverrides: {}, disabled: [], debts: null, extraDebtTarget: null, extraFacilities: null } });
}

function operatingSurfaceComposer() {
  const appSrc = sourceText(fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'));
  const planSrc = sourceText(fs.readFileSync(path.join(ROOT, 'public', 'plan.js'), 'utf8'));
  const grab = (src, re, label) => {
    const m = re.exec(src);
    if (!m) throw new Error('missing ' + label);
    return m[0];
  };
  return vm.runInNewContext([
    grab(appSrc, /^const money = .*$/m, 'money'),
    grab(appSrc, /^const money2 = .*$/m, 'money2'),
    grab(appSrc, /^const escapeHtml = .*$/m, 'escapeHtml'),
    grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
    grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
    grab(planSrc, /^function weeklyCapView\([\s\S]*?\n\}$/m, 'weeklyCapView'),
    grab(planSrc, /^function liveOperatingPlanUnavailable\([\s\S]*?\n\}$/m, 'liveOperatingPlanUnavailable'),
    grab(planSrc, /^function liveOperatingPlanNote\([\s\S]*?\n\}$/m, 'liveOperatingPlanNote'),
    grab(planSrc, /^function currentOperatingUnavailableHtml\([\s\S]*?\n\}$/m, 'currentOperatingUnavailableHtml'),
    grab(planSrc, /^function paydayActionRows\([\s\S]*?\n\}$/m, 'paydayActionRows'),
    grab(planSrc, /^function paydayCashNote\([\s\S]*?\n\}$/m, 'paydayCashNote'),
    grab(planSrc, /^function paydayGlanceCashNote\([\s\S]*?\n\}$/m, 'paydayGlanceCashNote'),
    grab(planSrc, /^function providerBalanceDate\([\s\S]*?\n\}$/m, 'providerBalanceDate'),
    grab(planSrc, /^function glanceUpdatedNote\([\s\S]*?\n\}$/m, 'glanceUpdatedNote'),
    grab(planSrc, /^function paydayCoverageNote\([\s\S]*?\n\}$/m, 'paydayCoverageNote'),
    grab(planSrc, /^const PAYDAY_ACTION_KIND = \{[\s\S]*?^\};$/m, 'PAYDAY_ACTION_KIND'),
    grab(planSrc, /^function paydayAllocationTrustNote\([\s\S]*?\n\}$/m, 'paydayAllocationTrustNote'),
    grab(planSrc, /^function paydayAllocationSheetHtml\([\s\S]*?\n\}$/m, 'paydayAllocationSheetHtml'),
    grab(planSrc, /^function currentPeriodConfidence\([\s\S]*?\n\}$/m, 'currentPeriodConfidence'),
    grab(planSrc, /^function currentPeriodBillGroup\([\s\S]*?\n\}$/m, 'currentPeriodBillGroup'),
    grab(planSrc, /^function betweenPaydaysOperatingHtml\([\s\S]*?\n\}$/m, 'betweenPaydaysOperatingHtml'),
    grab(planSrc, /^const FUTURE_PLAN_VERDICT = \{[\s\S]*?^\};$/m, 'FUTURE_PLAN_VERDICT'),
    grab(planSrc, /^const FUTURE_PLAN_FLEXIBILITY = \{[\s\S]*?^\};$/m, 'FUTURE_PLAN_FLEXIBILITY'),
    grab(planSrc, /^function futureCostNeedsAttention\([\s\S]*?\n\}$/m, 'futureCostNeedsAttention'),
    grab(planSrc, /^function futurePlanRemainingLabel\([\s\S]*?\n\}$/m, 'futurePlanRemainingLabel'),
    grab(planSrc, /^function futurePlanMeaning\([\s\S]*?\n\}$/m, 'futurePlanMeaning'),
    grab(planSrc, /^function futurePlanRequirement\([\s\S]*?\n\}$/m, 'futurePlanRequirement'),
    grab(planSrc, /^function futurePlanTiming\([\s\S]*?\n\}$/m, 'futurePlanTiming'),
    grab(planSrc, /^function futurePlanCardHtml\([\s\S]*?\n\}$/m, 'futurePlanCardHtml'),
    grab(planSrc, /^function futureGravityHtml\([\s\S]*?\n\}$/m, 'futureGravityHtml'),
    grab(planSrc, /^function operatingDebtAnswerHtml\([\s\S]*?\n\}$/m, 'operatingDebtAnswerHtml'),
    grab(planSrc, /^const REFRESH_TRUST_STATE = \{[\s\S]*?^\};$/m, 'REFRESH_TRUST_STATE'),
    grab(planSrc, /^function refreshTrustHtml\([\s\S]*?\n\}$/m, 'refreshTrustHtml'),
    grab(planSrc, /^function cashUnsafe\([\s\S]*?\n\}$/m, 'cashUnsafe'),
    grab(planSrc, /^function todayActionRowsHtml\([\s\S]*?\n\}$/m, 'todayActionRowsHtml'),
    grab(planSrc, /^function todayDecisionHtml\([\s\S]*?\n\}$/m, 'todayDecisionHtml'),
    grab(planSrc, /^function spendDecisionHtml\([\s\S]*?\n\}$/m, 'spendDecisionHtml'),
    grab(planSrc, /^function paydayBucketRow\([\s\S]*?\n\}$/m, 'paydayBucketRow'),
    grab(planSrc, /^function postedThisPeriodHtml\([\s\S]*?\n\}$/m, 'postedThisPeriodHtml'),
    grab(planSrc, /^function glanceSignedMoney\([\s\S]*?\n\}$/m, 'glanceSignedMoney'),
    grab(planSrc, /^function glanceMoney\([\s\S]*?\n\}$/m, 'glanceMoney'),
    grab(planSrc, /^function glanceLineLabel\([\s\S]*?\n\}$/m, 'glanceLineLabel'),
    grab(planSrc, /^function alreadyPaidRowsHtml\([\s\S]*?\n\}$/m, 'alreadyPaidRowsHtml'),
    grab(planSrc, /^function alreadyPaidHtml\([\s\S]*?\n\}$/m, 'alreadyPaidHtml'),
    grab(planSrc, /^function stillDueItems\([\s\S]*?\n\}$/m, 'stillDueItems'),
    grab(planSrc, /^function cashGlanceHtml\([\s\S]*?\n\}$/m, 'cashGlanceHtml'),
    grab(planSrc, /^function liveCurrentBalanceHtml\([\s\S]*?\n\}$/m, 'liveCurrentBalanceHtml'),
    grab(planSrc, /^function mustLeaveHtml\([\s\S]*?\n\}$/m, 'mustLeaveHtml'),
    grab(planSrc, /^function extraDebtGlanceHtml\([\s\S]*?\n\}$/m, 'extraDebtGlanceHtml'),
    grab(planSrc, /^function runningLeftoverHtml\([\s\S]*?\n\}$/m, 'runningLeftoverHtml'),
    grab(planSrc, /^function periodBillLine\([\s\S]*?\n\}$/m, 'periodBillLine'),
    grab(planSrc, /^function calendarCurrentUnavailableHtml\([\s\S]*?\n\}$/m, 'calendarCurrentUnavailableHtml'),
    grab(planSrc, /^function calendarIncomeHtml\([\s\S]*?\n\}$/m, 'calendarIncomeHtml'),
    grab(planSrc, /^function householdBudgetCycleText\([\s\S]*?\n\}$/m, 'householdBudgetCycleText'),
    grab(planSrc, /^function householdBudgetMetric\([\s\S]*?\n\}$/m, 'householdBudgetMetric'),
    grab(planSrc, /^function householdBudgetCategoryHtml\([\s\S]*?\n\}$/m, 'householdBudgetCategoryHtml'),
    grab(planSrc, /^function calendarBudgetHtml\([\s\S]*?\n\}$/m, 'calendarBudgetHtml'),
    grab(planSrc, /^function calendarPeriodBillsHtml\([\s\S]*?\n\}$/m, 'calendarPeriodBillsHtml'),
    grab(planSrc, /^function extraRepaymentHtml\([\s\S]*?\n\}$/m, 'extraRepaymentHtml'),
    grab(planSrc, /^function firstCardHtml\([\s\S]*?\n\}$/m, 'firstCardHtml'),
    grab(planSrc, /^function otherCardsHtml\([\s\S]*?\n\}$/m, 'otherCardsHtml'),
    grab(planSrc, /^function bigPurchasesHtml\([\s\S]*?\n\}$/m, 'bigPurchasesHtml'),
    grab(planSrc, /^function calendarFromTodayEvidenceHtml\([\s\S]*?\n\}$/m, 'calendarFromTodayEvidenceHtml'),
    grab(planSrc, /^function calendarWaterfallHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallHtml'),
    grab(planSrc, /^function calendarPickerHtml\([\s\S]*?\n\}$/m, 'calendarPickerHtml'),
    grab(planSrc, /^function calendarWaterfallsHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallsHtml'),
    grab(planSrc, /^function periodBillsHtml\([\s\S]*?\n\}$/m, 'periodBillsHtml'),
    grab(planSrc, /^function householdBudgetHtml\([\s\S]*?\n\}$/m, 'householdBudgetHtml'),
    grab(planSrc, /^function budgetDigestHtml\([\s\S]*?\n\}$/m, 'budgetDigestHtml'),
    grab(planSrc, /^function paydayAllocationSummaryHtml\([\s\S]*?\n\}$/m, 'paydayAllocationSummaryHtml'),
    grab(planSrc, /^function unavailableOperatingSurfaceHtml\([\s\S]*?\n\}$/m, 'unavailableOperatingSurfaceHtml'),
    grab(planSrc, /^function operatingSurfaceHtml\([\s\S]*?\n\}$/m, 'operatingSurfaceHtml'),
    // AMANDA SLICE 14 — the same-input schedule chain read by operatingSurfaceHtml.
    grab(planSrc, /^function budgetMonthPlanSpendSchedule\([\s\S]*?\n\}$/m, 'budgetMonthPlanSpendSchedule'),
    grab(planSrc, /^function budgetMonthKnobOpts\([\s\S]*?\n\}/m, 'budgetMonthKnobOpts'),
    grab(planSrc, /^function budgetTrajectoryCacheKeyFor\([\s\S]*?\n\}/m, 'budgetTrajectoryCacheKeyFor'),
    grab(planSrc, /^function simOpts\([\s\S]*?\n\}/m, 'simOpts'),
    grab(planSrc, /^function isValidIsoCalendarDate\([\s\S]*?\n\}/m, 'isValidIsoCalendarDate'),
    grab(planSrc, /^const BUDGET_MONTH_NAMES = [\s\S]*?\];/m, 'BUDGET_MONTH_NAMES'),
    grab(planSrc, /^function budgetMonthName\([\s\S]*?\n\}/m, 'budgetMonthName'),
    'let budgetMonthScheduleCache = null; let budgetMonthScheduleCacheKey = null;',
    grab(planSrc, /^function paydayInstructionShellHtml\([\s\S]*?\n\}$/m, 'paydayInstructionShellHtml'),
    '({ operatingSurfaceHtml, money2 })',
  ].join('\n'), { Forecast, state: { scenario: null, targetBuffer: 500, extraDebtMonthly: 0, incomeOverrides: {}, disabled: [], debts: null, extraDebtTarget: null, extraFacilities: null } });
}

function browserPlanComposer() {
  const appSrc = sourceText(fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'));
  const planSrc = sourceText(fs.readFileSync(path.join(ROOT, 'public', 'plan.js'), 'utf8'));
  const grab = (src, re, label) => {
    const m = re.exec(src);
    if (!m) throw new Error('missing ' + label);
    return m[0];
  };
  return vm.runInNewContext([
    grab(appSrc, /^const money = .*$/m, 'money'),
    grab(appSrc, /^const money2 = .*$/m, 'money2'),
    grab(appSrc, /^const escapeHtml = .*$/m, 'escapeHtml'),
    grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
    grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
    grab(planSrc, /^const fmtMonth = .*$/m, 'fmtMonth'),
    grab(planSrc, /^const addDays = .*$/m, 'addDays'),
    grab(planSrc, /^function weeklyCapView\([\s\S]*?\n\}$/m, 'weeklyCapView'),
    grab(planSrc, /^function liveOperatingPlanUnavailable\([\s\S]*?\n\}$/m, 'liveOperatingPlanUnavailable'),
    grab(planSrc, /^function liveOperatingPlanNote\([\s\S]*?\n\}$/m, 'liveOperatingPlanNote'),
    grab(planSrc, /^function currentOperatingUnavailableHtml\([\s\S]*?\n\}$/m, 'currentOperatingUnavailableHtml'),
    grab(planSrc, /^function currentOperatingCashHeroTiles\([\s\S]*?\n\}$/m, 'currentOperatingCashHeroTiles'),
    grab(planSrc, /^function currentOperatingConsumerDebtHeroTile\([\s\S]*?\n\}$/m, 'currentOperatingConsumerDebtHeroTile'),
    grab(planSrc, /^function currentOperatingTransferNoteHtml\([\s\S]*?\n\}$/m, 'currentOperatingTransferNoteHtml'),
    grab(planSrc, /^function paydayActionRows\([\s\S]*?\n\}$/m, 'paydayActionRows'),
    grab(planSrc, /^function paydayOtherActionRows\([\s\S]*?\n\}$/m, 'paydayOtherActionRows'),
    grab(planSrc, /^function paydayReservedIds\([\s\S]*?\n\}$/m, 'paydayReservedIds'),
    grab(planSrc, /^function paydayComingRows\([\s\S]*?\n\}$/m, 'paydayComingRows'),
    grab(planSrc, /^function paydaySheet\([\s\S]*?\n\}$/m, 'paydaySheet'),
    grab(planSrc, /^function paydayCashNote\([\s\S]*?\n\}$/m, 'paydayCashNote'),
    grab(planSrc, /^function paydayObligationNote\([\s\S]*?\n\}$/m, 'paydayObligationNote'),
    grab(planSrc, /^function paydayCoverageNote\([\s\S]*?\n\}$/m, 'paydayCoverageNote'),
    grab(planSrc, /^function paydayBillStatusNote\([\s\S]*?\n\}$/m, 'paydayBillStatusNote'),
    grab(planSrc, /^function paydayAmountCell\([\s\S]*?\n\}$/m, 'paydayAmountCell'),
    grab(planSrc, /^function paydayAnswerHtml\([\s\S]*?\n\}$/m, 'paydayAnswerHtml'),
    '({ paydayAnswerHtml, currentOperatingCashHeroTiles, currentOperatingConsumerDebtHeroTile, currentOperatingTransferNoteHtml })',
  ].join('\n'), { Forecast, state: { scenario: null, targetBuffer: 500, extraDebtMonthly: 0, incomeOverrides: {}, disabled: [], debts: null, extraDebtTarget: null, extraFacilities: null } });
}

console.log('\n=== 20. incomplete current cash still withholds a stale cycle as current ===');
{
  const LIVE_FAILURE_AT = '2026-08-31T18:00:00.000Z';
  const LIVE_FAILURE_AS_OF = '2026-08-31';
  const openingAsOf = String(liveData.plan.opening.asOf);
  ok(openingAsOf === '2026-08-19',
    'canonical opening on this main is still 2026-08-19');
  const independentOpening = independentSeaspanCycle(openingAsOf);
  const independentLive = independentSeaspanCycle(LIVE_FAILURE_AS_OF);
  ok(independentOpening.start === '2026-08-14' && independentOpening.end === '2026-08-27'
      && independentOpening.nextPayday === '2026-08-28',
    'independent 14-day steps from Aug 14: as-of Aug 19 is Aug 14–27');
  ok(independentLive.start === '2026-08-28' && independentLive.end === '2026-09-10'
      && independentLive.nextPayday === '2026-09-11',
    'independent 14-day steps from Aug 14: as-of Aug 31 is Aug 28–Sep 10');
  const engineOpening = Forecast.spendingCycle(liveData.plan, openingAsOf);
  const engineLive = Forecast.spendingCycle(liveData.plan, LIVE_FAILURE_AS_OF);
  ok(engineOpening && engineOpening.start === independentOpening.start
      && engineOpening.end === independentOpening.end,
    'spendingCycle stays faithful to the Aug 19 as-of it is given');
  ok(engineLive && engineLive.start === independentLive.start
      && engineLive.end === independentLive.end,
    'spendingCycle for a trusted Aug 31 as-of is Aug 28–Sep 10');

  const GLANCE_FETCHED_AT = '2026-08-31T12:11:00.000Z';
  const extra = {
    fetchedAt: GLANCE_FETCHED_AT,
    tweaks: {
      cashAt: '2026-08-31T17:55:00.000Z',
      cardAt: '2026-08-31T17:55:00.000Z',
      loanAt: '2026-08-31T17:55:00.000Z',
      triangleAt: '2026-08-31T17:55:00.000Z',
    },
  };
  const failExtra = {
    fetchedAt: GLANCE_FETCHED_AT,
    tweaks: Object.assign({ omitProviderIds: [3001] }, extra.tweaks),
  };
  const canonical = clone(liveData);
  let threw = null;
  try {
    overlay(canonical, failExtra);
  } catch (err) {
    threw = err;
  }
  ok(threw && /missing-live-cash-evidence/.test(threw.message),
    'Aug 31 overlay fails closed when required current cash is incomplete',
    threw && threw.message);

  const served = serveFixtureOverlay(canonical, failExtra);
  ok(served.liveOverlay && served.liveOverlay.applied === false,
    'server overlay fail-closes rather than applying a mixed Aug 31 / Aug 19 state');
  ok(served.liveOverlay.operatingPlan === Live.OPERATING_PLAN_UNAVAILABLE,
    'fail-closed later observation marks the current operating plan unavailable');
  ok(/unavailable/.test(String(served.liveOverlay.operatingPlanNote || ''))
      && /stale/.test(String(served.liveOverlay.operatingPlanNote || '')),
    'fail-closed copy is explicit unavailable/stale');
  ok(String(served.meta.asOf) === openingAsOf
      && String(served.plan.opening.asOf) === openingAsOf,
    'fail-closed overlay does not advance the served opening');
  ok(served.liveOverlay.observedAsOf === LIVE_FAILURE_AS_OF,
    'observed as-of is the observation household date, not Date.now');

  const staleAdvice = Forecast.recommend(served.plan, served.meta.asOf, {
    debts: served.debts,
    revolvingExtra: served.revolvingExtra,
    targetBuffer: served.plan.defaults.targetBuffer,
    operatingPlan: served.liveOverlay.operatingPlan,
    operatingPlanNote: served.liveOverlay.operatingPlanNote,
  });
  const active = activeCalendarPeriod(staleAdvice);
  ok(active && active.operatingPlanUnavailable === true,
    'Forecast withholds the current operating plan rather than publishing the dated cycle');
  ok(active.spendingCycleLabel == null && active.spendingCycle == null,
    'Household Budget does not print Spending cycle: Aug 14–Aug 27 as current');
  ok(!/Aug 14/.test(String(active.operatingPlanNote || ''))
      && !/Aug 28/.test(String(active.operatingPlanNote || '')),
    'unavailable copy does not mix an Aug 31 cycle with an Aug 19 opening');
  ok(/unavailable/.test(String(active.operatingPlanNote || ''))
      && /stale/.test(String(active.operatingPlanNote || '')),
    'Forecast note is explicit unavailable/stale');
  ok(staleAdvice.operatingPlanUnavailable === true
      && staleAdvice.weekly == null
      && staleAdvice.currentPeriodAction
      && staleAdvice.currentPeriodAction.unavailable === true
      && staleAdvice.currentPeriodAction.remainingClaim === 'unavailable',
    'Forecast withholds weekly permission and current-period action while operatingPlan is unavailable');
  ok(!staleAdvice.paydayAllocation
      || staleAdvice.paydayAllocation.extraDebt == null
      || staleAdvice.paydayAllocation.extraDebt.status === 'unavailable'
      || staleAdvice.paydayAllocation.extraDebt.allocated == null,
    'Forecast withholds extra-debt instruction while operatingPlan is unavailable');
  ok(staleAdvice.funding == null,
    'Forecast does not publish opening-gap funding as a current claim while operatingPlan is unavailable');

  const datedCash = independentDatedCash(served.plan);
  const datedChequing = independentChequingCash(served.plan);
  const laterIncome = independentLaterIncome(served.plan, openingAsOf, LIVE_FAILURE_AS_OF);
  const laterSum = Math.round(laterIncome.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  const mixedAvailable = Math.round((datedChequing + laterSum) * 100) / 100;
  ok(near(datedCash, independentDatedCash(canonical.plan))
      && near(datedChequing, independentChequingCash(canonical.plan)),
    'fail-closed overlay leaves dated opening cash untouched');
  ok(laterIncome.some(r => r.id === 'childBenefit' && r.date === '2026-08-20')
      && laterIncome.some(r => r.id === 'payroll' && r.date === '2026-08-28')
      && laterIncome.some(r => r.id === 'amandaSalaryMonthEnd' && r.date === '2026-08-31'),
    'independent calendar: child benefit Aug 20, Seaspan Aug 28, Amanda Aug 31 are after the dated opening');
  ok(laterSum > 0 && mixedAvailable > datedChequing && !near(mixedAvailable, datedChequing),
    'dated cash plus those later paychecks is a different current-looking Available mix');
  ok(near(active.currentBalance, datedChequing) && active.openingKnown === true,
    'active waterfall opening is the dated chequing opening, not a later invented balance');
  ok(active.incomeAdded == null && active.available == null
      && (!active.income || active.income.length === 0),
    'Forecast does not add later-dated income as arriving or publish Available as dated cash plus arriving');
  ok(active.afterRemainingBills == null
      && active.afterHouseholdBudget == null
      && (active.householdBudget || []).length === 0
      && active.budgetHold == null,
    'Forecast does not publish Household Budget planned dollars or leftover as the current waterfall');
  const observedNet = observedCashNet(served.liveOverlay && served.liveOverlay.observedCash);
  ok(near(active.currentBalance, datedChequing)
      && (observedNet == null || near(observedNet, datedChequing)
        || !near(active.currentBalance, observedNet)),
    'Forecast does not mix live observedCash into the dated opening');

  const waterfall = calendarWaterfallComposer();
  const glanceNote = waterfall.glanceUpdatedNote(openingAsOf, served.liveOverlay);
  ok(!/Updated Aug 31/.test(glanceNote)
      && !/5:11/.test(glanceNote)
      && !/12:11/.test(glanceNote),
    'Current Balance glance does not stamp unapplied overlay fetchedAt as Updated now');
  ok(/Aug 19/.test(glanceNote) || /unavailable/.test(glanceNote) || /stale/.test(glanceNote)
      || /Current Balance/.test(glanceNote),
    'unapplied glance stays on the dated opening, not wall-clock freshness');
  const waterfallHtml = waterfall.calendarWaterfallHtml(
    active, served.liveOverlay, staleAdvice.paydayAllocation);
  ok(/data-operating-plan="unavailable"/.test(waterfallHtml)
      && /data-current-waterfall="unavailable"/.test(waterfallHtml)
      && /unavailable/.test(waterfallHtml)
      && /stale/.test(waterfallHtml),
    'active calendar waterfall copy is explicit unavailable/stale');
  ok(!/Updated Aug 31/.test(waterfallHtml) && !/5:11/.test(waterfallHtml),
    'Current Balance glance on the active waterfall does not stamp fetchedAt onto dated-opening cash');
  ok(!/arriving/.test(waterfallHtml)
      && !/Still arriving/.test(waterfallHtml)
      && !/data-income-status="arriving"/.test(waterfallHtml)
      && !/Child benefit/.test(waterfallHtml)
      && !/Payroll — Seaspan/.test(waterfallHtml)
      && !/Amanda salary/.test(waterfallHtml),
    'already-dated later income is not listed as arriving on the current waterfall');
  ok(!waterfallHtml.includes(money2en(mixedAvailable))
      && !waterfallHtml.includes(waterfall.money2(mixedAvailable)),
    'Available is not published as dated cash plus arriving Aug 20/28/31 paychecks');
  ok(waterfallHtml.includes(waterfall.money2(datedChequing)),
    'dated opening cash may still print as lookback Current Balance');
  ok(!/Spending cycle:/.test(waterfallHtml)
      && !/planned this period/.test(waterfallHtml)
      && !/plannedPayday/.test(waterfallHtml),
    'Household Budget planned payday dollars are not printed as the current operating waterfall');

  const surface = operatingSurfaceComposer();
  const surfaceHtml = surface.operatingSurfaceHtml({
    advice: staleAdvice,
    weekly: staleAdvice.weekly,
    recommended: staleAdvice.weekly,
    liveOverlay: served.liveOverlay,
    refreshTrust: served.refreshTrust,
    asOf: served.meta.asOf,
  });
  ok(/data-unavailable-primary/.test(surfaceHtml)
      && /data-current-operating="unavailable"/.test(surfaceHtml)
      && /Last trusted opening/.test(surfaceHtml)
      && /Dated balance — not current/.test(surfaceHtml)
      && surfaceHtml.includes(surface.money2(datedChequing)),
    'Plan operating surface fail-closes at the page with one dated/non-current opening');
  ok(!/Current Balance/.test(surfaceHtml)
      && !/data-calendar-waterfall/.test(surfaceHtml)
      && !/data-calendar-period-picker/.test(surfaceHtml)
      && (surfaceHtml.match(/The dated opening is stale/g) || []).length === 1,
    'Plan operating surface does not print Current Balance, the pay-period waterfall, or eleven stale notes');
  ok(!/Updated August 31/.test(surfaceHtml)
      && !/Updated Aug 31/.test(surfaceHtml)
      && /Later refresh observed August 31 was not applied/.test(surfaceHtml),
    'unapplied Aug 31 observation is not presented as the financial as-of');
  ok(!/needs confirmation/.test(surfaceHtml),
    'unavailable surface does not keep a stale Bell needs-confirmation row');

  const operating = OA.fromRefreshedState(served, { mode: 'live-overlay' });
  ok(operating.provenance.operatingPlan === Live.OPERATING_PLAN_UNAVAILABLE,
    'operating-answer provenance records operatingPlan unavailable');
  ok(operating.moneyAvailable.value == null
      && operating.moneyAvailable.status === 'unavailable'
      && operating.currentSpendingPermission.weekly == null
      && operating.currentSpendingPermission.remainingClaim === 'unavailable'
      && operating.extraDebtAllocation.status === 'unavailable'
      && operating.extraDebtAllocation.allocated == null,
    'operating-answer does not copy money available, spend permission, or extra-debt as current from the stale opening');

  const packet = Assistant.buildPacket({
    data: served,
    periods: Assistant.loadPeriods(),
    questionsMarkdown: '',
    now: LIVE_FAILURE_AT,
    env: {},
  });
  ok(packet.current.spendableHouseholdCash.status !== 'ok'
      && packet.current.spendableHouseholdCash.current === false,
    'get_atlas_current does not publish dated opening cash as current');
  ok(packet.forecast.status === 'unavailable'
      && packet.forecast.recommendation.status === 'unavailable'
      && packet.forecast.currentPeriodAction.status === 'unavailable',
    'get_atlas_current does not emit a current recommendation or current-period action');
  ok(!/\d+\s*\/\s*week/.test(JSON.stringify(packet.forecast.recommendation))
      && packet.forecast.recommendation.weekly == null,
    'assistant forecast recommendation does not carry a weekly spend permission');
  ok(packet.planning && packet.planning.trajectory
      && packet.planning.trajectory.status === 'ready'
      && packet.planning.trajectory.source === 'Forecast.baselineTrajectory',
    'stale operating plan still exposes baseline trajectory like Planning');

  const planSrc = sourceText(fs.readFileSync(path.join(ROOT, 'public', 'plan.js'), 'utf8'));
  const helperSrc = [
    /function liveOperatingPlanUnavailable\([\s\S]*?\n\}/.exec(planSrc),
    /function liveOperatingPlanNote\([\s\S]*?\n\}/.exec(planSrc),
    /function currentOperatingUnavailableHtml\([\s\S]*?\n\}/.exec(planSrc),
  ];
  ok(helperSrc.every(Boolean),
    'plan.js names the current-operating unavailable helper');
  const unavailableHtml = vm.runInNewContext(
    `${helperSrc.map(m => m[0]).join('\n')}\ncurrentOperatingUnavailableHtml;`,
    { Forecast } // the PA-5 verdict is Forecast's (finish-line audit finding 12)
  )(staleAdvice, served.liveOverlay);
  ok(/data-current-operating="unavailable"/.test(unavailableHtml)
      && /data-operating-plan="unavailable"/.test(unavailableHtml)
      && /unavailable/.test(unavailableHtml)
      && /stale/.test(unavailableHtml)
      && !/\$/.test(unavailableHtml),
    'browser operating helper emits unavailable/stale and no spend amount');
  const liveHtml = vm.runInNewContext(
    `${helperSrc.map(m => m[0]).join('\n')}\ncurrentOperatingUnavailableHtml;`,
    { Forecast } // the PA-5 verdict is Forecast's (finish-line audit finding 12)
  )({ weekly: 400 }, { operatingPlan: 'live' });
  ok(liveHtml == null, 'browser helper stays silent when the operating plan is live');
  const browser = browserPlanComposer();
  const paydayHtml = browser.paydayAnswerHtml({
    plan: served.plan,
    asOf: served.meta.asOf,
    advice: staleAdvice,
    recommended: staleAdvice.weekly,
    weekly: staleAdvice.weekly,
    liveOverlay: served.liveOverlay,
  });
  ok(/data-current-operating="unavailable"/.test(paydayHtml)
      && /data-operating-plan="unavailable"/.test(paydayHtml)
      && /unavailable/.test(paydayHtml)
      && /stale/.test(paydayHtml)
      && !/\$/.test(paydayHtml),
    'paydayAnswerHtml fail-closes the current payday answer on the Aug 31 unavailable fixture');
  ok(!/Money available/.test(paydayHtml)
      && !/What to do with this paycheque/.test(paydayHtml)
      && !/Bills \/ required payments/.test(paydayHtml)
      && !/Coming before next payday/.test(paydayHtml)
      && !/Funding risks/.test(paydayHtml)
      && !/payday-hero/.test(paydayHtml),
    'unavailable paydayAnswerHtml does not emit current Money available, paycheque action, or other current action from the Aug 19 opening');
  const heroTiles = browser.currentOperatingCashHeroTiles(
    served.plan,
    served.meta.asOf,
    staleAdvice.sim || { events: [] },
    staleAdvice,
    served.liveOverlay
  );
  const spendableTile = heroTiles.find(t => t.lab === 'Spendable household cash');
  const cashOutTile = heroTiles.find(t => t.lab === 'Next cash-out total');
  ok(spendableTile && spendableTile.val === 'unavailable' && !/\$/.test(String(spendableTile.val)),
    'Plan hero tile does not publish numeric current Spendable household cash while unavailable');
  ok(cashOutTile && cashOutTile.val === 'unavailable' && !/\$/.test(String(cashOutTile.val)),
    'Plan hero tile does not publish numeric current Next cash-out total while unavailable');
  const renderFn = /function renderPlan\([\s\S]*?\n\}/.exec(planSrc);
  const paydayFn = /function paydayAnswerHtml\([\s\S]*?\n\}/.exec(planSrc);
  ok((served.plan.income || []).some(row => row && row.id === 'amandaSalaryMonthEnd'),
    'canonical plan still counts Amanda month-end salary on the dated opening');
  const transferHtml = browser.currentOperatingTransferNoteHtml(
    staleAdvice, served.liveOverlay, 1, served.meta.asOf);
  ok(/data-operating-plan="unavailable"/.test(transferHtml)
      && /unavailable/.test(transferHtml)
      && /stale/.test(transferHtml)
      && !/has to land by/.test(transferHtml)
      && !/Tennis BC salary/.test(transferHtml)
      && !/\$/.test(transferHtml),
    'Amanda salary dependency block does not publish has-to-land-by from the dated opening');
  const staleDebt = Forecast.projectDebts(served.plan, served.debts, served.meta.asOf, {
    revolvingExtra: served.revolvingExtra,
    targetBuffer: served.plan.defaults.targetBuffer,
    weeklyVariable: staleAdvice.weekly,
  });
  const staleToday = (staleDebt.marks || []).find(m => m.day === 0)
    || staleDebt.marks[staleDebt.marks.length - 1];
  ok(staleToday && staleToday.consumer != null && Number(staleToday.consumer) !== 0,
    'stale Aug 19 walk still has a numeric consumer-debt figure to withhold');
  const debtTile = browser.currentOperatingConsumerDebtHeroTile(
    staleAdvice, served.liveOverlay, staleToday);
  ok(debtTile && debtTile.lab === 'Consumer debt'
      && debtTile.val === 'unavailable'
      && !/\$/.test(String(debtTile.val))
      && !/\$/.test(String(debtTile.note))
      && /unavailable/.test(String(debtTile.note))
      && /stale/.test(String(debtTile.note)),
    'Consumer debt hero tile does not publish numeric current debt/headroom from the dated opening');
  ok(renderFn && /currentOperatingCashHeroTiles\(/.test(renderFn[0])
      && /currentOperatingConsumerDebtHeroTile\(/.test(renderFn[0])
      && /currentOperatingTransferNoteHtml\(/.test(renderFn[0]),
    'renderPlan prints currentOperatingCashHeroTiles, Consumer debt, and Amanda salary helpers rather than a parallel current path');
  ok(paydayFn && /currentOperatingUnavailableHtml\(/.test(paydayFn[0])
      && /liveOperatingPlanUnavailable\(/.test(paydayFn[0]),
    'paydayAnswerHtml withholds the current payday block while operatingPlan is unavailable');
  const surfaceFn = /function operatingSurfaceHtml\([\s\S]*?\n\}/.exec(planSrc);
  ok(surfaceFn && /liveOperatingPlanUnavailable/.test(surfaceFn[0])
      && /unavailableOperatingSurfaceHtml/.test(surfaceFn[0]),
    'operatingSurfaceHtml fail-closes at the page when operatingPlan is unavailable');
  const extraFn = /function extraRepaymentHtml\([\s\S]*?\n\}/.exec(planSrc);
  ok(extraFn && /operatingPlanUnavailable/.test(extraFn[0])
      && /data-operating-plan="unavailable"/.test(extraFn[0]),
    'calendar extra-debt instruction fail-closes on the active unavailable period');
  const mixed = Forecast.recommend(served.plan, served.meta.asOf, {
    debts: served.debts,
    revolvingExtra: served.revolvingExtra,
    targetBuffer: served.plan.defaults.targetBuffer,
  });
  const mixedActive = activeCalendarPeriod(mixed);
  ok(mixedActive && mixedActive.spendingCycle && mixedActive.spendingCycle.start === '2026-08-14',
    'without the overlay flag, Aug 19 as-of still computes Aug 14–27 (cycle math unchanged)');

  const trusted = clone(liveData);
  trusted.plan = Object.assign({}, trusted.plan, {
    income: (trusted.plan.income || []).map(row => {
      if (!row || row.id !== 'amandaSalaryMonthEnd') return row;
      return Object.assign({}, row, { firstDue: '2026-09-30' });
    }),
  });
  const trustedServed = serveFixtureOverlay(trusted, extra);
  ok(trustedServed.liveOverlay && trustedServed.liveOverlay.applied === true,
    'unposted same-day joint-cash bills do not fail the overlay when inbound is not in-window');
  ok(trustedServed.liveOverlay.operatingPlan === Live.OPERATING_PLAN_LIVE,
    'independently trusted current opening applies as live');
  ok(String(trustedServed.plan.opening.asOf) === LIVE_FAILURE_AS_OF
      && String(trustedServed.meta.asOf) === LIVE_FAILURE_AS_OF,
    'trusted overlay advances as-of with the opening, not a mixed state');
  const trustedAdvice = Forecast.recommend(trustedServed.plan, trustedServed.meta.asOf, {
    debts: trustedServed.debts,
    revolvingExtra: trustedServed.revolvingExtra,
    targetBuffer: trustedServed.plan.defaults.targetBuffer,
    operatingPlan: trustedServed.liveOverlay.operatingPlan,
    operatingPlanNote: trustedServed.liveOverlay.operatingPlanNote,
  });
  const trustedActive = activeCalendarPeriod(trustedAdvice);
  ok(trustedActive && trustedActive.spendingCycle
      && trustedActive.spendingCycle.start === independentLive.start
      && trustedActive.spendingCycle.end === independentLive.end
      && trustedActive.spendingCycleLabel === engineLive.label
      && trustedActive.operatingPlanUnavailable !== true,
    'trusted Aug 31 as-of publishes Household Budget Aug 28–Sep 10');
  ok(trustedAdvice.operatingPlanUnavailable !== true
      && trustedAdvice.weekly === 0
      && !(trustedAdvice.currentPeriodAction && trustedAdvice.currentPeriodAction.unavailable),
    'trusted control keeps the current period published while weekly sits at the zero unsupported-cap sentinel');
  // ATLAS-076 (B1): the canonical plan declares four funding options, but
  // none is an eligible automatic cash source in this scenario - the
  // tennis-account option resolves to zero under the Q25 observational
  // policy, debt options are borrowing capacity rather than cash, and
  // the remaining options are unusable. The opening gap is therefore
  // honestly unfunded: no invented part, no recovery injection, and no
  // weekly permission published off it.
  ok(trustedAdvice.gap && Number(trustedAdvice.gap.amount) > 0
      && trustedAdvice.funding && trustedAdvice.funding.feasible === false
      && near(trustedAdvice.funding.shortfall, trustedAdvice.gap.amount)
      && Number(trustedAdvice.funding.allocated) === 0
      && Number(trustedAdvice.funding.borrowed) === 0
      && (trustedAdvice.funding.parts || []).length === 0
      && (trustedAdvice.simOptions.injections || []).length === 0
      && trustedAdvice.weekly === 0,
    'trusted control opening gap is honestly unfunded: infeasible funding, full shortfall, zero allocation/borrowing/parts/injections, weekly zero');
  const trustedOperating = OA.fromRefreshedState(trustedServed, { mode: 'live-overlay' });
  ok(trustedOperating.currentSpendingPermission.weekly === null
      && trustedOperating.moneyAvailable.value === null
      && trustedOperating.extraDebtAllocation.status === 'unavailable',
    'trusted balances without a confirmed card-coverage opening withhold spend permission');
  const trustedPacket = Assistant.buildPacket({
    data: trustedServed,
    periods: Assistant.loadPeriods(),
    questionsMarkdown: '',
    now: LIVE_FAILURE_AT,
    env: {},
  });
  ok(trustedPacket.forecast.status === 'unavailable'
      && trustedPacket.forecast.currentPeriodAction.status === 'unavailable'
      && trustedPacket.current.spendableHouseholdCash.status === 'unavailable',
    'assistant keeps unconfirmed card coverage separate from trusted observed cash');
  const trustedPayday = browser.paydayAnswerHtml({
    plan: trustedServed.plan,
    asOf: trustedServed.meta.asOf,
    advice: trustedAdvice,
    recommended: trustedAdvice.weekly,
    weekly: trustedAdvice.weekly,
    liveOverlay: trustedServed.liveOverlay,
  });
  ok(!/data-current-operating="unavailable"/.test(trustedPayday)
      && !/data-operating-plan="unavailable"/.test(trustedPayday)
      && /payday-spend/.test(trustedPayday)
      && /payday-refuse/.test(trustedPayday)
      && !/payday-hero/.test(trustedPayday),
    'trusted control paydayAnswerHtml refuses the weekly permission (payday-refuse, no payday-hero) while the current opening stays visible');
  // ATLAS-076 (B1): positive publication is preserved on a wholly
  // synthetic fixture whose gap is covered by an explicitly declared
  // cash source - never an invented one. Opening 320 against a 200
  // buffer leaves 120 of headroom; a 170 bill dated before the 1200
  // income lands opens an independently computable gap of exactly 50.
  const b1SynthPlan = {
    windowDays: 21,
    defaults: { targetBuffer: 200 },
    startingCash: { breakdown: [{ id: 'chequing-a', value: 320 }] },
    opening: { asOf: '2026-08-21' },
    income: [{
      id: 'pay', label: 'Payday', frequency: 'once', date: '2026-08-28',
      amount: 1200, confidence: 'confirmed',
    }],
    bills: [{
      id: 'pre', label: 'Pre-payday bill', frequency: 'once',
      date: '2026-08-24', amount: 170, confidence: 'confirmed',
    }],
    obligations: [],
    commitments: [],
    funding: { options: [] },
  };
  const b1Funded = Forecast.recommend(b1SynthPlan, '2026-08-21', {
    fundingSources: [{
      id: 'test-cash', label: 'Test cash source', short: 'test cash',
      available: 80, rank: 1, debtId: null,
    }],
    debts: [], extraFacilities: [], targetBuffer: 200,
  });
  ok(b1Funded.gap && near(b1Funded.gap.amount, 50)
      && b1Funded.funding && b1Funded.funding.feasible === true
      && near(b1Funded.funding.allocated, 50)
      && near(b1Funded.funding.shortfall, 0)
      && Number(b1Funded.funding.borrowed) === 0
      && (b1Funded.funding.parts || []).length === 1
      && (b1Funded.funding.parts || [])[0].id === 'test-cash'
      && (b1Funded.simOptions.injections || []).length === 1
      && near((b1Funded.simOptions.injections || [])[0].amount, 50)
      && b1Funded.weekly > 0,
    'synthetic funded control: declared cash source covers the 50 gap exactly once (allocation/injection 50, no shortfall or borrowing, feasible, positive weekly)');
  const b1FundedPayday = browser.paydayAnswerHtml({
    plan: b1SynthPlan,
    asOf: '2026-08-21',
    advice: b1Funded,
    recommended: b1Funded.weekly,
    weekly: b1Funded.weekly,
    liveOverlay: { operatingPlan: 'live' },
  });
  ok(/payday-hero/.test(b1FundedPayday) && !/payday-refuse/.test(b1FundedPayday),
    'synthetic funded control publishes a positive weekly hero');
  const b1Empty = Forecast.recommend(b1SynthPlan, '2026-08-21', {
    fundingSources: [],
    debts: [], extraFacilities: [], targetBuffer: 200,
  });
  ok(b1Empty.gap && near(b1Empty.gap.amount, 50)
      && b1Empty.funding && b1Empty.funding.feasible === false
      && near(b1Empty.funding.shortfall, 50)
      && (b1Empty.funding.parts || []).length === 0
      && (b1Empty.simOptions.injections || []).length === 0
      && b1Empty.weekly === 0,
    'synthetic empty-source control: same 50 gap fails closed (full shortfall, no parts, no injection, weekly zero)');
  const b1EmptyPayday = browser.paydayAnswerHtml({
    plan: b1SynthPlan,
    asOf: '2026-08-21',
    advice: b1Empty,
    recommended: b1Empty.weekly,
    weekly: b1Empty.weekly,
    liveOverlay: { operatingPlan: 'live' },
  });
  ok(/payday-refuse/.test(b1EmptyPayday) && !/payday-hero/.test(b1EmptyPayday),
    'synthetic empty-source control refuses permission with no weekly hero');
  const trustedHero = browser.currentOperatingCashHeroTiles(
    trustedServed.plan,
    trustedServed.meta.asOf,
    trustedAdvice.sim,
    trustedAdvice,
    trustedServed.liveOverlay
  );
  const trustedCash = trustedHero.find(t => t.lab === 'Spendable household cash');
  const trustedOut = trustedHero.find(t => t.lab === 'Next cash-out total');
  ok(trustedCash && trustedCash.val !== 'unavailable' && /\$/.test(String(trustedCash.val)),
    'trusted control still publishes numeric Spendable household cash');
  ok(!trustedOut || (trustedOut.val !== 'unavailable' && /\$/.test(String(trustedOut.val))),
    'trusted control still publishes numeric Next cash-out total when a cash-out exists');
  const trustedDeadline = Forecast.amandaHouseholdIncomeDeadline(
    trustedServed.plan, trustedServed.meta.asOf, {
      debts: trustedServed.debts,
      revolvingExtra: trustedServed.revolvingExtra,
      targetBuffer: trustedServed.plan.defaults.targetBuffer,
      weeklyVariable: trustedAdvice.weekly,
      notBefore: trustedServed.meta.asOf,
    });
  const trustedTransfer = browser.currentOperatingTransferNoteHtml(
    trustedAdvice, trustedServed.liveOverlay,
    trustedDeadline && trustedDeadline.amount, trustedDeadline && trustedDeadline.neededBy);
  ok(/Tennis BC salary/.test(trustedTransfer)
      && !/data-operating-plan="unavailable"/.test(trustedTransfer)
      && (trustedDeadline && trustedDeadline.neededBy
        ? /has to land by/.test(trustedTransfer)
        : true),
    'trusted control still publishes the Amanda salary dependency');
  const trustedDebtProj = Forecast.projectDebts(
    trustedServed.plan, trustedServed.debts, trustedServed.meta.asOf, {
      revolvingExtra: trustedServed.revolvingExtra,
      targetBuffer: trustedServed.plan.defaults.targetBuffer,
      weeklyVariable: trustedAdvice.weekly,
    });
  const trustedTodayMark = (trustedDebtProj.marks || []).find(m => m.day === 0)
    || trustedDebtProj.marks[trustedDebtProj.marks.length - 1];
  const trustedDebtTile = browser.currentOperatingConsumerDebtHeroTile(
    trustedAdvice, trustedServed.liveOverlay, trustedTodayMark);
  ok(trustedDebtTile && trustedDebtTile.val !== 'unavailable'
      && /\$/.test(String(trustedDebtTile.val)),
    'trusted control still publishes numeric Consumer debt');
  const trustedGlance = waterfall.glanceUpdatedNote(
    trustedServed.meta.asOf, trustedServed.liveOverlay);
  ok(/As of August 31/.test(trustedGlance) && !/fetchedAt/.test(trustedGlance),
    'trusted applied overlay stamps Current Balance from provider observedAsOf, not fetchedAt');
  const trustedWaterfallHtml = waterfall.calendarWaterfallHtml(
    trustedActive, trustedServed.liveOverlay, trustedAdvice.paydayAllocation);
  ok(!/data-current-waterfall="unavailable"/.test(trustedWaterfallHtml)
      && trustedActive.operatingPlanUnavailable !== true
      && trustedAdvice.defaultView.liveCurrentBalance != null,
    'trusted control still publishes live Current Balance and a current (non-stale) payday card');
  const snap = trustedServed.plan.opening && trustedServed.plan.opening.paydaySnapshot;
  const datedPlan = trusted.plan;
  const datedAsOf = datedPlan.opening && datedPlan.opening.asOf;
  const child = (datedPlan.income || []).find(s => s && s.id === 'childBenefit');
  const travel = (datedPlan.obligations || []).find(o => o && o.id === 'travel');
  let independentMorning = Forecast.startingCashAmount(datedPlan);
  if (child && datedAsOf && datedAsOf < '2026-08-20' && '2026-08-20' < trustedActive.start) {
    independentMorning = Math.round((independentMorning + Number(child.amount)) * 100) / 100;
  }
  const represented = new Set(((trustedServed.plan.opening && trustedServed.plan.opening.representedEvents) || [])
    .filter(r => r && r.date && r.date < trustedActive.start)
    .map(r => String(r.id) + '@' + String(r.date)));
  if (travel && datedAsOf && datedAsOf < '2026-08-26' && '2026-08-26' < trustedActive.start
      && represented.has('travel@2026-08-26')) {
    independentMorning = Math.round((independentMorning - Number(travel.amount)) * 100) / 100;
  }
  ok(!snap,
    'trusted overlay does not retain a scheduled-only paydaySnapshot from the dated opening');
  ok(trustedActive.openingKnown !== true && trustedActive.opening == null
      && trustedAdvice.defaultView.liveCurrentBalance != null
      && !near(independentMorning, trustedAdvice.defaultView.liveCurrentBalance),
    'trusted mid-period overlay withholds the incomplete walked opening and still publishes live Current Balance');
  ok(trustedActive.available != null && near(trustedActive.available, trustedActive.incomeTotal),
    'Payday balance still publishes the period income identity');

  const budgetFn = /function calendarBudgetHtml\([\s\S]*?\n\}/.exec(planSrc);
  const unavailableFn = /function calendarCurrentUnavailableHtml\([\s\S]*?\n\}/.exec(planSrc);
  const waterfallFn = /function calendarWaterfallHtml\([\s\S]*?\n\}/.exec(planSrc);
  const glanceFn = /function glanceUpdatedNote\([\s\S]*?\n\}/.exec(planSrc);
  ok(budgetFn && /operatingPlanUnavailable/.test(budgetFn[0])
      && /calendarCurrentUnavailableHtml/.test(budgetFn[0])
      && !/Date\.now/.test(budgetFn[0]),
    'plan.js prints Forecast operatingPlanUnavailable; it does not invent a cycle or wall-clock as-of');
  ok(unavailableFn && /data-current-waterfall="unavailable"/.test(unavailableFn[0])
      && /stale/.test(unavailableFn[0]),
    'calendarCurrentUnavailableHtml is the current-waterfall unavailable copy');
  ok(waterfallFn && /planUnavailable/.test(waterfallFn[0])
      && /calendarCurrentUnavailableHtml/.test(waterfallFn[0])
      && !/Date\.now/.test(waterfallFn[0]),
    'calendarWaterfallHtml withholds arriving / Available / leftover as current when unavailable');
  const providerDateFn = /function providerBalanceDate\([\s\S]*?\n\}/.exec(planSrc);
  ok(glanceFn && /providerBalanceDate/.test(glanceFn[0])
      && !/fetchedAt/.test(glanceFn[0])
      && !/Date\.now/.test(glanceFn[0]),
    'glanceUpdatedNote reads providerBalanceDate and does not use fetchedAt or the browser clock');
  ok(providerDateFn && /observedAsOf/.test(providerDateFn[0])
      && /evidenceDate/.test(providerDateFn[0])
      && !/fetchedAt/.test(providerDateFn[0])
      && !/Date\.now/.test(providerDateFn[0]),
    'providerBalanceDate uses cash evidenceDate / observedAsOf, not fetchedAt');
  const fromFn = /function operatingPlanFromOverlay\([\s\S]*?\n\}/.exec(
    fs.readFileSync(path.join(ROOT, 'scripts', 'live-plan.js'), 'utf8'));
  ok(fromFn && /liveAsOf > historicalOpeningAsOf/.test(fromFn[0]) && !/Date\.now/.test(fromFn[0]),
    'operatingPlan unavailable is later observed as-of vs dated opening, not wall-clock');
  filesUnchanged('same-day inbound fail-closed stale cycle');
}

console.log('\n=== 21. named paycheck identity supplies actuals and applies when proven ===');
{
  const LIVE_AT = '2026-08-31T18:00:00.000Z';
  const LIVE_DAY = '2026-08-31';
  // Owner-confirmed month-end net from ACCOUNT_FACTS / plan.income. Used as
  // an additional identity guard on the uniquely paired TENNIS INCOME→BILLS
  // transfer, not as identity.
  const OWNER_CONFIRMED_MONTH_END = 2387.99;
  const WRONG_AMOUNT_AMANDA = 81.17;
  const UNRELATED_TRANSFER = 790;
  const SYNTHETIC_GROCER = 12.34;
  const SYNTHETIC_INOUT = 3000;
  const openingAsOf = String(liveData.plan.opening.asOf);
  const salaryRules = (identity.rules || []).filter(r =>
    r && (r.eventId === 'amandaSalary15' || r.eventId === 'amandaSalaryMonthEnd'));
  ok(salaryRules.length === 2
      && salaryRules.every(r => r.transactionKind === 'transfer'
        && r.atlasAccountId === 'chequing-a'
        && r.direction === 'credit'
        && r.counterpartExternalId === 'tennis-income'
        && r.settlesWhen === 'exact-scheduled-amount'
        && !r.payeePattern
        && !(r.payeePatterns || []).length),
    'salary identity is BILLS transfer uniquely paired to TENNIS INCOME, not amount alone');
  ok(!(identity.rules || []).some(r =>
      r && (r.eventId === 'amandaSalary15' || r.eventId === 'amandaSalaryMonthEnd')
      && /tennis/i.test(JSON.stringify([r.payeePattern, r.payeePatterns]))),
    'direct household-account Tennis BC payee match does not exist');
  const scheduledEom = (liveData.plan.income || [])
    .find(s => s && s.id === 'amandaSalaryMonthEnd');
  ok(scheduledEom && near(scheduledEom.amount, OWNER_CONFIRMED_MONTH_END),
    'independent owner-confirmed month-end salary is still $2,387.99');
  ok(openingAsOf === '2026-08-19', 'canonical opening on this main is still 2026-08-19');
  ok(independentMonthDate(2026, 8, 31) === LIVE_DAY,
    'independent calendar: Aug 31 is the last day of August');
  ok(independentBiweeklyDates('2026-08-14', openingAsOf, LIVE_DAY).includes(PAYDAY_AS_OF),
    'independent 14-day steps from Aug 14: Aug 28 is in the rewind window');

  const categories = [
    { id: 21, name: 'Income', is_income: true, exclude_from_totals: false },
    { id: 24, name: 'Payment/Transfer', is_income: false, exclude_from_totals: true },
    { id: 31, name: 'Groceries', is_income: false, exclude_from_totals: false },
  ];
  const window = {
    startDate: '2026-08-16',
    endDate: LIVE_DAY,
    complete: true,
    hasMore: false,
    truncated: false,
  };
  const freshness = {
    cashAt: '2026-08-31T17:55:00.000Z',
    cardAt: '2026-08-31T17:55:00.000Z',
    loanAt: '2026-08-31T17:55:00.000Z',
    triangleAt: '2026-08-31T17:55:00.000Z',
  };
  const seaspanTx = {
    id: 96028, account_id: 3001, date: PAYDAY_AS_OF, amount: -SYNTHETIC_PAYROLL,
    payee: 'SEASPAN PAYROLL', category_id: 21, is_pending: false, status: 'reviewed',
  };
  const billsTransferTx = {
    id: 96031, account_id: 3001, date: LIVE_DAY, amount: -OWNER_CONFIRMED_MONTH_END,
    payee: 'INTERNAL TRANSFER', category_id: 24, exclude_from_totals: true,
    is_pending: false, status: 'reviewed',
  };
  const tennisIncomeCounterpartTx = {
    id: 96042, account_id: 3009, date: LIVE_DAY, amount: OWNER_CONFIRMED_MONTH_END,
    payee: 'INTERNAL TRANSFER', category_id: 24, exclude_from_totals: true,
    is_pending: false, status: 'reviewed',
  };
  const weeklySourceCounterpartTx = {
    id: 96043, account_id: 3002, date: LIVE_DAY, amount: OWNER_CONFIRMED_MONTH_END,
    payee: 'INTERNAL TRANSFER', category_id: 24, exclude_from_totals: true,
    is_pending: false, status: 'reviewed',
  };
  const tennisBcPayeeTx = {
    id: 96038, account_id: 3001, date: LIVE_DAY, amount: -OWNER_CONFIRMED_MONTH_END,
    payee: 'TENNIS BC', category_id: 21, is_pending: false, status: 'reviewed',
  };
  const tennisIncomeDepositTx = {
    id: 96039, account_id: 3009, date: LIVE_DAY, amount: -OWNER_CONFIRMED_MONTH_END,
    payee: 'TENNIS BC', category_id: 21, is_pending: false, status: 'reviewed',
  };
  const unrelatedTransferTx = {
    id: 96040, account_id: 3001, date: LIVE_DAY, amount: -UNRELATED_TRANSFER,
    payee: 'INTERNAL TRANSFER', category_id: 24, exclude_from_totals: true,
    is_pending: false, status: 'reviewed',
  };
  const weeklyTransferTx = {
    id: 96041, account_id: 3002, date: LIVE_DAY, amount: -OWNER_CONFIRMED_MONTH_END,
    payee: 'INTERNAL TRANSFER', category_id: 24, exclude_from_totals: true,
    is_pending: false, status: 'reviewed',
  };
  const wrongAmountTransferTx = {
    id: 96037, account_id: 3001, date: LIVE_DAY, amount: -WRONG_AMOUNT_AMANDA,
    payee: 'INTERNAL TRANSFER', category_id: 24, exclude_from_totals: true,
    is_pending: false, status: 'reviewed',
  };
  const expTx = {
    id: 96032, account_id: 3001, date: LIVE_DAY, amount: -40.4,
    payee: 'TENNIS BC EXP', category_id: 21, is_pending: false, status: 'reviewed',
  };
  const inOutTxs = [
    {
      id: 96033, account_id: 3002, date: LIVE_DAY, amount: -SYNTHETIC_INOUT,
      payee: 'SYNTHETIC IN', category_id: 24, is_pending: false, status: 'reviewed',
    },
    {
      id: 96034, account_id: 3002, date: LIVE_DAY, amount: SYNTHETIC_INOUT,
      payee: 'SYNTHETIC OUT', category_id: 24, is_pending: false, status: 'reviewed',
    },
  ];
  const grocerTx = {
    id: 96035, account_id: 3001, date: LIVE_DAY, amount: SYNTHETIC_GROCER,
    payee: 'SYNTHETIC GROCER', category_id: 31, is_pending: false, status: 'reviewed',
  };
  const amountOnlyTx = {
    id: 96036, account_id: 3001, date: LIVE_DAY, amount: -OWNER_CONFIRMED_MONTH_END,
    payee: 'UNKNOWN DEPOSIT', category_id: 21, is_pending: false, status: 'reviewed',
  };

  const canonical = clone(liveData);
  const expectedCash = Math.round(
    (Forecast.startingCashAmount(canonical.plan) + OWNER_CONFIRMED_MONTH_END + SYNTHETIC_PAYROLL) * 100
  ) / 100;
  const datedCash = independentDatedCash(canonical.plan);
  const datedChequing = independentChequingCash(canonical.plan);
  ok(!near(expectedCash, datedChequing) && expectedCash > datedChequing,
    'live posted cash with identified deposits is not the dated opening');

  const extraFor = (transactions, cashAdd) => ({
    fetchedAt: LIVE_AT,
    categories,
    transactionWindow: window,
    tweaks: Object.assign({
      'chequing-a': cashValue(canonical, 'chequing-a')
        + (cashAdd == null ? OWNER_CONFIRMED_MONTH_END + SYNTHETIC_PAYROLL : cashAdd),
    }, freshness),
    transactions,
  });

  const provenTxs = [seaspanTx, billsTransferTx, tennisIncomeCounterpartTx, expTx]
    .concat(inOutTxs, [grocerTx]);
  const observed = overlay(canonical, extraFor(provenTxs));
  const amandaHit = (observed.report.representedEventCandidates || [])
    .find(c => c.id === 'amandaSalaryMonthEnd' && c.date === LIVE_DAY);
  const seaspanHit = (observed.report.representedEventCandidates || [])
    .find(c => c.id === 'payroll' && c.date === PAYDAY_AS_OF);
  ok(amandaHit && amandaHit.identity === 'transfer+counterpart+account+date'
      && amandaHit.amountNotUsed === true,
    'observer identity-matches the TENNIS INCOME→BILLS pair; amount is a guard, not identity');
  ok(near(amandaHit.observedAmount, -OWNER_CONFIRMED_MONTH_END)
      && amandaHit.atlasAccountId === 'chequing-a',
    'matched salary actual is the exact scheduled transfer into BILLS');
  ok((observed.report.representedEventCandidates || [])
      .filter(c => c.id === 'amandaSalaryMonthEnd' && c.date === LIVE_DAY).length === 1,
    'the scheduled salary is represented once');
  ok(seaspanHit && seaspanHit.identity === 'payee+account+date',
    'observer identity-matches in-window Seaspan by payee');
  ok(!(observed.report.representedEventCandidates || [])
      .some(c => c.id === 'amandaSalaryMonthEnd' && near(Math.abs(c.observedAmount), 40.4)),
    'TENNIS BC EXP reimbursement is not the month-end salary identity');
  ok(!(observed.report.representedEventCandidates || [])
      .some(c => near(Math.abs(Number(c.observedAmount)), SYNTHETIC_INOUT)),
    'ignored $3000 in-and-out is not a named income candidate');

  ok(observed.data.liveOverlay && observed.data.liveOverlay.applied === true,
    'overlay applies when the salary-to-BILLS transfer is uniquely proven');
  ok(observed.data.liveOverlay.operatingPlan === Live.OPERATING_PLAN_LIVE,
    'proven overlay is a current operating plan');
  ok(String(observed.data.meta.asOf) === LIVE_DAY
      && String(observed.data.plan.opening.asOf) === LIVE_DAY,
    'proven overlay advances the in-memory Forecast start to the observation date');
  ok((observed.data.plan.opening.representedEvents || [])
      .some(e => e.id === 'amandaSalaryMonthEnd' && e.date === LIVE_DAY),
    'proven BILLS transfer is named as amandaSalaryMonthEnd on the in-memory live opening');
  ok((observed.data.plan.opening.representedEvents || [])
      .some(e => e.id === 'payroll' && e.date === PAYDAY_AS_OF),
    'proven in-window Seaspan is named on the in-memory live opening');
  ok(!(observed.data.plan.opening.representedEvents || [])
      .some(e => near(Math.abs(Number(e.amount)), SYNTHETIC_INOUT) || e.id === 'ignored-3000'),
    'ignored $3000 in-and-out is not a represented opening event');

  const actuals = observed.data.liveOverlay.currentPeriodActuals;
  ok(actuals && actuals.schema === 'atlas-current-period-actuals/v1'
      && Array.isArray(actuals.transactions) && actuals.transactions.length > 0,
    'applied overlay supplies current-period actuals when Lunch Money has them');
  ok(O.currentPeriodActualsLooksSanitized(actuals),
    'supplied actuals packet stays sanitized');
  ok((actuals.representedActuals || [])
      .some(row => row.id === 'amandaSalaryMonthEnd' && row.date === LIVE_DAY
        && near(row.actual, -OWNER_CONFIRMED_MONTH_END)),
    'actuals packet links the proven BILLS transfer to amandaSalaryMonthEnd');
  ok((actuals.transactions || []).some(tx => near(tx.amount, SYNTHETIC_GROCER)
        && tx.excludeFromTotals !== true),
    'unmatched grocery actual remains in the packet');
  ok((actuals.transactions || []).filter(tx => near(Math.abs(Number(tx.amount)), SYNTHETIC_INOUT))
      .length === 2,
    'ignored $3000 in-and-out stays observed as a pair, not dropped from actuals');

  ok(!Forecast.expandEvents(observed.data.plan, LIVE_DAY, LIVE_DAY, {})
      .some(e => e.id === 'amandaSalaryMonthEnd' && e.date === LIVE_DAY),
    'Forecast does not emit the posted salary again on the live as-of');
  ok(Forecast.expandEvents(canonical.plan, openingAsOf, LIVE_DAY, {})
      .some(e => e.id === 'amandaSalaryMonthEnd' && e.date === LIVE_DAY),
    'the dated opening would still have emitted that month-end salary');
  ok(near(Forecast.startingCashAmount(observed.data.plan), expectedCash),
    'live starting cash is the independent posted sum, not dated cash plus plan paychecks');
  const laterIncome = independentLaterIncome(canonical.plan, openingAsOf, LIVE_DAY);
  const laterSum = Math.round(laterIncome.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  const mixedAvailable = Math.round((datedCash + laterSum) * 100) / 100;
  ok(laterIncome.some(r => r.id === 'amandaSalaryMonthEnd' && r.date === LIVE_DAY)
      && laterIncome.some(r => r.id === 'payroll' && r.date === PAYDAY_AS_OF),
    'independent calendar still names the later paychecks after the dated opening');
  ok(!near(expectedCash, mixedAvailable),
    'live posted cash is not dated opening plus later plan paycheck amounts');

  const advice = Forecast.recommend(observed.data.plan, LIVE_DAY, {
    currentPeriodActuals: actuals,
    debts: observed.data.debts,
    revolvingExtra: observed.data.revolvingExtra,
    targetBuffer: canonical.plan.defaults.targetBuffer,
    operatingPlan: observed.data.liveOverlay.operatingPlan,
    operatingPlanNote: observed.data.liveOverlay.operatingPlanNote,
  });
  const noRulePlan = { ...observed.data.plan };
  delete noRulePlan.cardPurchaseCoverage;
  const noRule = Forecast.recommend(noRulePlan, LIVE_DAY, {
    currentPeriodActuals: actuals,
    debts: observed.data.debts,
    revolvingExtra: observed.data.revolvingExtra,
    targetBuffer: canonical.plan.defaults.targetBuffer,
    operatingPlan: observed.data.liveOverlay.operatingPlan,
    operatingPlanNote: observed.data.liveOverlay.operatingPlanNote,
  });
  ok(noRule.operatingPlanUnavailable !== true && noRule.cardCoverageUnavailable === true
      && noRule.weekly === null && noRule.currentPeriodAction.inflows.some(r => r.id === 'payroll'),
    'proven income remains factual while missing card-coverage confirmation withholds spending');
  ok(advice.currentPeriodAction.inflows.some(r => r.id === 'payroll')
      && advice.cardPurchaseCoverage?.status === 'ready' && advice.cardPurchaseCoverage.reservedCash === 0,
    'under the canonical rule (opening after this fixture) proven income stays factual and no card hold applies',
    JSON.stringify(advice.cardPurchaseCoverage?.issues));
  const action = advice.currentPeriodAction || Forecast.currentPeriodAction(
    observed.data.plan, LIVE_DAY, {
      currentPeriodActuals: actuals,
      debts: observed.data.debts,
    });
  ok(action && action.thisPayday === PAYDAY_AS_OF,
    'thisPayday on Aug 31 is the Aug 28 cheque date, not the whole current period');
  ok((action.thisPaydayPaid && action.thisPaydayPaid.inflows || [])
      .some(r => r.id === 'payroll' && r.date === PAYDAY_AS_OF),
    'thisPaydayPaid keeps proven Friday Seaspan');
  ok(!(action.thisPaydayPaid && action.thisPaydayPaid.inflows || [])
      .some(r => r.id === 'amandaSalaryMonthEnd'),
    'month-end Tennis BC is not dumped onto this payday');
  ok((action.inflows || []).some(r => r.id === 'amandaSalaryMonthEnd' && r.date === LIVE_DAY),
    'proven BILLS transfer is a current-period represented inflow');
  ok(!(action.inflows || []).some(r => near(Math.abs(Number(r.actual)), SYNTHETIC_INOUT)
      || near(Number(r.planned), SYNTHETIC_INOUT)),
    'ignored $3000 in-and-out is not current-period income');
  const leftover = advice.paydayAllocation && advice.paydayAllocation.available;
  ok(leftover == null || (!near(leftover, datedCash + SYNTHETIC_INOUT)
      && !near(leftover, mixedAvailable)),
    'leftover is not dated cash plus the ignored $3000 or later plan paychecks');

  const preview = C.buildPreview(observed.report, { data: canonical });
  ok((preview.unresolved || []).some(row =>
      row.reason === 'unmatched-household-cash-must-not-write'
      && near(row.amount, SYNTHETIC_GROCER)),
    'unmatched household grocery still must not write');
  ok((preview.unresolved || []).some(row =>
      row.reason === 'unmatched-household-cash-must-not-write'
      && near(Math.abs(Number(row.amount)), SYNTHETIC_INOUT)),
    'ignored $3000 in-and-out still must not write when unmatched');
  ok(!(preview.proposed || []).some(row =>
      near(Math.abs(Number(row.proposedValue)), SYNTHETIC_INOUT)
      || near(Math.abs(Number(row.currentValue)), SYNTHETIC_INOUT)),
    'canonical preview does not write the ignored $3000');
  ok(!(preview.ownerQuestions || []).some(row =>
      near(Math.abs(Number(row.amount)), SYNTHETIC_INOUT)
      && /income/i.test(String(row.reason || row.id || ''))),
    'ignored $3000 is not promoted to classified income');
  ok(observed.writesCanonicalState === false
      && observed.data.liveOverlay.writesCanonicalState === false
      && observed.data.liveOverlay.productionWrite === false,
    'proven overlay still does not write canonical state');

  function assertSalaryNotRepresented(label, transactions, cashAdd) {
    const extra = extraFor(transactions, cashAdd);
    const result = overlay(canonical, extra);
    ok(result.data.liveOverlay.applied === true
        && result.data.liveOverlay.operatingPlan === Live.OPERATING_PLAN_LIVE,
      label + ' still applies trusted current cash');
    ok(!(result.data.plan.opening.representedEvents || [])
        .some(c => c.id === 'amandaSalaryMonthEnd' && c.date === LIVE_DAY),
      label + ' does not represent the month-end salary');
    ok((result.data.plan.opening.notReliedUponEvents || [])
        .some(c => c.id === 'amandaSalaryMonthEnd' && c.date === LIVE_DAY),
      label + ' leaves the month-end salary unresolved');
    const seen = O.observe({
      provider: 'lunchmoney',
      payload: payloadFrom(canonical, extra),
      accountMap,
      data: canonical,
      identity,
      fetchedAt: LIVE_AT,
    });
    ok(!(seen.representedEventCandidates || [])
        .some(c => c.id === 'amandaSalaryMonthEnd' && c.date === LIVE_DAY),
      label + ' observer still does not represent the month-end salary');
    const expectedCash = Math.round((
      Number(extra.tweaks['chequing-a']) +
      Number(cashValue(canonical, 'chequing-b'))
    ) * 100) / 100;
    ok(near(Forecast.startingCashAmount(result.data.plan), expectedCash),
      label + ' opening is the observed household-cash sum');
    const advice = Forecast.recommend(result.data.plan, LIVE_DAY, {
      debts: result.data.debts,
      operatingPlan: result.data.liveOverlay.operatingPlan,
    });
    ok(advice.paydayAllocation
        && !near(advice.paydayAllocation.available, expectedCash + OWNER_CONFIRMED_MONTH_END),
      label + ' does not add the unproven salary on top of observed cash');
    const servedLive = serveFixtureOverlay(canonical, extra);
    ok(servedLive.liveOverlay && servedLive.liveOverlay.applied === true,
      label + ' served overlay remains live');
    ok(String(servedLive.plan.opening.asOf) === LIVE_DAY,
      label + ' served opening is the live as-of');
  }

  assertSalaryNotRepresented(
    'same-day unknown payee even at the scheduled amount',
    [seaspanTx, amountOnlyTx, grocerTx].concat(inOutTxs));
  assertSalaryNotRepresented(
    'direct household TENNIS BC payee, even at the scheduled amount',
    [seaspanTx, tennisBcPayeeTx, expTx, grocerTx].concat(inOutTxs));
  assertSalaryNotRepresented(
    'TENNIS INCOME account deposit / reimbursement',
    [seaspanTx, tennisIncomeDepositTx, expTx, grocerTx].concat(inOutTxs));
  assertSalaryNotRepresented(
    'unrelated household transfer',
    [seaspanTx, unrelatedTransferTx, grocerTx].concat(inOutTxs),
    UNRELATED_TRANSFER + SYNTHETIC_PAYROLL);
  assertSalaryNotRepresented(
    'unrelated exact-amount BILLS transfer without a TENNIS INCOME counterpart',
    [seaspanTx, billsTransferTx, grocerTx].concat(inOutTxs));
  assertSalaryNotRepresented(
    'exact-amount BILLS transfer sourced from WEEKLY, not TENNIS INCOME',
    [seaspanTx, billsTransferTx, weeklySourceCounterpartTx, grocerTx].concat(inOutTxs));
  assertSalaryNotRepresented(
    'BILLS transfer plus TENNIS INCOME deposit, without the opposite-leg debit',
    [seaspanTx, billsTransferTx, tennisIncomeDepositTx, grocerTx].concat(inOutTxs));
  assertSalaryNotRepresented(
    'exact-amount transfer into WEEKLY rather than BILLS',
    [seaspanTx, weeklyTransferTx, grocerTx].concat(inOutTxs));
  assertSalaryNotRepresented(
    'BILLS transfer with the wrong amount',
    [seaspanTx, wrongAmountTransferTx, expTx, grocerTx].concat(inOutTxs),
    WRONG_AMOUNT_AMANDA + SYNTHETIC_PAYROLL);
  assertSalaryNotRepresented(
    'TENNIS BC EXP reimbursement alone',
    [seaspanTx, expTx, grocerTx].concat(inOutTxs));

  const served = serveFixtureOverlay(canonical, extraFor(provenTxs));
  ok(served.liveOverlay && served.liveOverlay.applied === true,
    'server overlay applies the uniquely proven salary-to-BILLS transfer');
  ok(served.liveOverlay.currentPeriodActuals
      && Array.isArray(served.liveOverlay.currentPeriodActuals.transactions)
      && served.liveOverlay.currentPeriodActuals.transactions.length > 0,
    'served overlay keeps current-period actuals');
  filesUnchanged('named paycheck identity overlay');
}

console.log('\n' + '═'.repeat(60));
if (failures) {
  console.log(`FAILED — ${failures} live-plan check(s)`);
  process.exit(1);
}
console.log('ALL LIVE-PLAN OVERLAY CHECKS PASSED');
