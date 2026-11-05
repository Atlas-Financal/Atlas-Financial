'use strict';
/* AF-REFRESH-05 — recompute the operating answer from refreshed state.
 *
 * Independent of scripts/operating-answer.js for the financial values:
 * the same refreshed plan/asOf/debts/actuals are supplied directly to
 * Forecast.recommend. The projector must copy those fields. Overlay
 * cash movement is also checked with hand arithmetic on named posted
 * amounts (L-002). Live data.json cents are a MATCH baseline, not the
 * specification (L-006). Canonical files are hashed for no-write of
 * the live-overlay path.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const O = require('../scripts/provider-observe.js');
const C = require('../scripts/canonical-refresh.js');
const Live = require('../scripts/live-plan.js');
const OA = require('../scripts/operating-answer.js');
const Forecast = require('../public/forecast.js');
const { independentSpendableOpening } = require('./test-helpers');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data.json');
const POSITIONS = path.join(ROOT, 'docs', 'positions.csv');
const PERIODS = path.join(ROOT, 'public', 'periods.json');
const SNAPSHOTS = path.join(ROOT, 'snapshots');
const LIVE_MAP = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'b81-account-map.json');
const PENDING = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'lunchmoney-pending-acceptance.json');
const PENDING_MAP = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'pending-account-map.json');
const AUTO = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'automatic-payment-settlement.json');
const IDENTITY = path.join(ROOT, 'docs', 'connectivity', 'transaction-identity.json');
const LIVE_SCRIPT = path.join(ROOT, 'scripts', 'live-plan.js');
const CANONICAL_SCRIPT = path.join(ROOT, 'scripts', 'canonical-refresh.js');
const OA_SCRIPT = path.join(ROOT, 'scripts', 'operating-answer.js');
const FETCHED_AT = '2026-08-21T18:00:00.000Z';
const OBSERVED = '2026-08-21T17:55:00.000Z';
const LIVE_AS_OF = '2026-08-21';
const CASH_PURCHASE = 30;
const SYNTHETIC_CURRENT = 400;
const SYNTHETIC_OBSERVED = 390;
const POSTED_CASH = new Set(['chequing-a', 'chequing-b', 'savings']);
const PRECISION = { unavailable: 0, 'posted-only': 1, precise: 2 };

let failures = 0;
function ok(cond, label, detail) {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}
function near(a, b, eps) { return Math.abs(Number(a) - Number(b)) <= (eps == null ? 0.005 : eps); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function load(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function hashFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
function hashTree() {
  const snapNames = fs.readdirSync(SNAPSHOTS).filter(n => n.endsWith('.json')).sort();
  const snap = snapNames.map(n => n + ':' + hashFile(path.join(SNAPSHOTS, n))).join('|');
  return {
    data: hashFile(DATA),
    positions: hashFile(POSITIONS),
    periods: hashFile(PERIODS),
    snapshots: crypto.createHash('sha256').update(snap).digest('hex'),
  };
}

// Independent invented bill amounts, not values copied from the household.
// The three receipt amounts sum to 176.82 by hand.
function withInventedAutoBills(data) {
  const x = JSON.parse(JSON.stringify(data));
  const amounts = { bcaa: 41.37, icbc: 62.19, resp: 73.26,
    'bcaa-aug15-outstanding': 41.37, 'icbc-aug15-outstanding': 62.19,
    'resp-aug15-outstanding': 73.26 };
  for (const bill of x.plan.bills || []) if (Object.hasOwn(amounts, bill.id)) bill.amount = amounts[bill.id];
  return x;
}
const liveData = withInventedAutoBills(load(DATA));
const accountMap = load(LIVE_MAP);
const identity = load(IDENTITY);
const pendingPayload = load(PENDING);
const pendingMap = load(PENDING_MAP);
const autoPayPayload = load(AUTO);
const beforeTree = hashTree();
const periods = fs.existsSync(PERIODS) ? load(PERIODS) : null;

function cashValue(data, id) {
  const row = (((data.plan || {}).startingCash || {}).breakdown || []).find(r => r && r.id === id);
  return row ? Number(row.value) : null;
}
function debt(data, id) {
  return ((data.debts || []).find(d => d && d.id === id)) || null;
}
function setCash(data, id, value) {
  const row = data.plan.startingCash.breakdown.find(r => r.id === id);
  if (!row) throw new Error('missing cash ' + id);
  row.value = value;
}
function independentSpendable(plan) {
  return independentSpendableOpening(plan);
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
      id: 3001, name: 'BILLS ACCOUNT', type: 'cash', subtype: 'checking',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t['chequing-a'] != null ? t['chequing-a'] : cashValue(data, 'chequing-a'),
      updated_at: t.cashAt || OBSERVED, balance_last_update: t.cashAt || OBSERVED,
    },
    {
      id: 3002, name: 'WEEKLY SPENDING', type: 'cash', subtype: 'checking',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t['chequing-b'] != null ? t['chequing-b'] : cashValue(data, 'chequing-b'),
      updated_at: t.cashAt || OBSERVED, balance_last_update: t.cashAt || OBSERVED,
    },
    {
      id: 3003, name: 'EMERGENCY SAVING', type: 'cash', subtype: 'savings',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.savings != null ? t.savings : cashValue(data, 'savings'),
      updated_at: t.savingsAt || t.cashAt || OBSERVED, balance_last_update: t.savingsAt || t.cashAt || OBSERVED,
    },
    {
      id: 3004, name: 'PERSONAL CREDIT CARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.tdcc != null ? t.tdcc : debt(data, 'tdcc').balance,
      credit_limit: debt(data, 'tdcc').limit,
      updated_at: t.cardAt || OBSERVED, balance_last_update: t.cardAt || OBSERVED,
    },
    {
      id: 3005, name: 'TD CASH BACK VISA* CARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.cashback != null ? t.cashback : debt(data, 'cashback').balance,
      credit_limit: debt(data, 'cashback').limit,
      updated_at: t.cardAt || OBSERVED, balance_last_update: t.cardAt || OBSERVED,
    },
    {
      id: 3006, name: 'TRAVEL VISA', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.travelvisa != null ? t.travelvisa : debt(data, 'travelvisa').balance,
      credit_limit: debt(data, 'travelvisa').limit,
      updated_at: t.cardAt || OBSERVED, balance_last_update: t.cardAt || OBSERVED,
    },
    {
      id: 3007, name: 'LINE OF CREDIT - HOME EQUITY', type: 'loan', subtype: 'line_of_credit',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.heloc != null ? t.heloc : debt(data, 'heloc').balance,
      updated_at: t.loanAt || OBSERVED, balance_last_update: t.loanAt || OBSERVED,
    },
    {
      id: 3008, name: 'MORTGAGE', type: 'loan', subtype: 'mortgage',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.mortgage != null ? t.mortgage : debt(data, 'mortgage').balance,
      updated_at: t.loanAt || OBSERVED, balance_last_update: t.loanAt || OBSERVED,
    },
    {
      id: 3010, name: 'TRIANGLE MASTERCARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'Canadian Tire Bank', currency: 'cad',
      balance: t.triangle != null ? t.triangle : debt(data, 'triangle').balance,
      credit_limit: debt(data, 'triangle').limit,
      updated_at: t.triangleAt || OBSERVED, balance_last_update: t.triangleAt || OBSERVED,
    },
  ];
}
function payloadFrom(data, extra) {
  const extraPayload = extra || {};
  return {
    provider: 'lunchmoney',
    fetchedAt: extraPayload.fetchedAt || FETCHED_AT,
    source: 'Synthetic AF-REFRESH-05 fixture. Not a live institution pull.',
    pendingCoverage: extraPayload.pendingCoverage === undefined
      ? completePendingCoverage()
      : extraPayload.pendingCoverage,
    accounts: matchingAccounts(data, extraPayload.tweaks),
    transactions: extraPayload.transactions || [],
  };
}
function overlay(data, extra) {
  return Live.fromObservation({
    data,
    payload: payloadFrom(data, extra),
    accountMap,
    identity,
  });
}
function directRecommend(data, opts) {
  opts = opts || {};
  const plan = data.plan;
  const asOf = OA.asOfFrom(data, opts);
  return Forecast.recommend(plan, asOf, OA.recommendOpts(data, opts));
}
function filesUnchanged(label) {
  const now = hashTree();
  ok(now.data === beforeTree.data, `${label}: data.json bytes unchanged`);
  ok(now.positions === beforeTree.positions, `${label}: positions.csv unchanged`);
  ok(now.periods === beforeTree.periods, `${label}: periods.json unchanged`);
  ok(now.snapshots === beforeTree.snapshots, `${label}: snapshots unchanged`);
}
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-af-refresh-05-'));
}
function writeTempData(dir, data) {
  const dest = path.join(dir, 'data.json');
  fs.writeFileSync(dest, `${JSON.stringify(data, null, 4)}\n`);
  return dest;
}
function writeTempJson(dir, name, value) {
  const dest = path.join(dir, name);
  fs.writeFileSync(dest, `${JSON.stringify(value, null, 2)}\n`);
  return dest;
}
function runCli(script, args) {
  try {
    const stdout = execFileSync(process.execPath, [script].concat(args), {
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
function withCompleteCoverage(payload, extraWindow) {
  const out = clone(payload);
  out.pendingCoverage = {
    complete: true,
    basis: O.PENDING_COVERAGE_BASIS,
    hasMore: false,
    startDate: null,
    endDate: null,
    truncated: false,
  };
  out.transactionWindow = Object.assign({
    startDate: '2026-08-16',
    endDate: '2026-08-20',
    complete: true,
    hasMore: false,
    truncated: false,
  }, extraWindow || {});
  return out;
}
function remapAutoTx(tx) {
  const accountId = tx.account_id === 1001 ? 3001
    : tx.account_id === 1002 ? 3002
      : tx.account_id;
  return Object.assign({}, tx, { account_id: accountId });
}
function readyTrustedPayload(opts) {
  opts = opts || {};
  const out = withCompleteCoverage(pendingPayload, opts.window);
  out.fetchedAt = opts.fetchedAt || '2026-08-20T16:00:00.000Z';
  let extra = (autoPayPayload.transactions || []).map(remapAutoTx);
  if (opts.omitCmaw) extra = extra.filter(tx => tx.id !== 8104);
  if (opts.omitUnmatched) extra = extra.filter(tx => tx.id !== 8199);
  out.transactions = (out.transactions || []).concat(extra);
  out.accounts = (out.accounts || []).map(account => Object.assign({}, account, {
    updated_at: opts.updatedAt || '2026-08-20T15:55:00.000Z', balance_last_update: opts.updatedAt || '2026-08-20T15:55:00.000Z',
  }));
  if (opts.chequingB != null) {
    out.accounts = out.accounts.map(account => (
      account.id === 3002 ? Object.assign({}, account, { balance: opts.chequingB }) : account
    ));
  }
  return out;
}
function alignMappedPosted(data, payload, accountMap) {
  for (const account of payload.accounts || []) {
    const mapping = O.mappingFor(accountMap, account.id);
    if (!mapping || !mapping.canonical || account.balance == null) continue;
    if (mapping.canonical.collection === 'cash' && POSTED_CASH.has(mapping.canonical.id)) {
      setCash(data, mapping.canonical.id, Number(account.balance));
    } else if (mapping.canonical.collection === 'debts') {
      const row = data.debts.find(d => d.id === mapping.canonical.id);
      if (row) row.balance = Number(account.balance);
    }
  }
}
function trustedCase() {
  const payload = readyTrustedPayload({
    chequingB: SYNTHETIC_OBSERVED,
    omitCmaw: true,
  });
  const data = clone(liveData);
  alignMappedPosted(data, payload, pendingMap);
  setCash(data, 'chequing-b', SYNTHETIC_CURRENT);
  return { payload, data };
}
function precisionRank(claim) {
  return Object.prototype.hasOwnProperty.call(PRECISION, claim) ? PRECISION[claim] : 0;
}
function assertCopiesForecast(packet, advice, label) {
  const alloc = advice.paydayAllocation || {};
  const action = advice.currentPeriodAction || {};
  const planUnavailable = packet.provenance && packet.provenance.operatingPlan === 'unavailable';
  ok(packet.source === 'Forecast.recommend', `${label}: source is Forecast.recommend`);
  if (planUnavailable) {
    ok(packet.moneyAvailable.value == null
        && packet.moneyAvailable.status === 'unavailable',
      `${label}: money available is withheld while the current operating plan is unavailable`);
  } else {
    ok(near(packet.moneyAvailable.value, alloc.available),
      `${label}: money available is paydayAllocation.available`,
      `${packet.moneyAvailable.value} vs ${alloc.available}`);
  }
  ok(near(packet.protectedObligations.allocated, alloc.obligations.allocated)
    && near(packet.protectedObligations.wanted, alloc.obligations.wanted)
    && near(packet.protectedObligations.shortfall, alloc.obligations.shortfall),
    `${label}: protected obligations copy paydayAllocation.obligations`);
  ok(packet.currentSpendingPermission.weekly === advice.weekly,
    `${label}: weekly permission is Forecast.recommend.weekly`,
    `${packet.currentSpendingPermission.weekly} vs ${advice.weekly}`);
  if (planUnavailable) {
    ok(packet.currentSpendingPermission.spendPermission == null,
      `${label}: spend permission is withheld`);
  } else {
    ok(near(packet.currentSpendingPermission.spendPermission, action.spendPermission),
      `${label}: spend permission is currentPeriodAction.spendPermission`);
  }
  ok(packet.currentSpendingPermission.remainingClaim === action.remainingClaim,
    `${label}: remainingClaim is copied from currentPeriodAction`);
  ok(near(packet.futureCostProtection.protectedPath.allocated, alloc.protectedPath.allocated),
    `${label}: future-path protection copies paydayAllocation.protectedPath`);
  ok(near(packet.extraDebtAllocation.allocated, alloc.extraDebt.allocated),
    `${label}: extra-debt allocation copies paydayAllocation.extraDebt`);
  ok(JSON.stringify(packet.limitations.risks) === JSON.stringify(alloc.risks || []),
    `${label}: limitations.risks are paydayAllocation.risks`);
}

console.log('\n=== A. projector copies Forecast; it does not recompute ===');
{
  const src = fs.readFileSync(OA_SCRIPT, 'utf8');
  ok(/Forecast\.recommend/.test(src), 'operating-answer.js calls Forecast.recommend');
  ok(!/todayIncome/.test(src), 'projector does not recompute available from todayIncome');
  ok(!/periodDays/.test(src) && !/\/\s*7/.test(src),
    'projector does not reslice weekly permission into a period amount');
  ok(!/roundCent|round2/.test(src), 'projector does not round financial amounts of its own');
  ok(!/\*\s*CALENDAR_MONTH_DAYS|CALENDAR_MONTH_DAYS/.test(src),
    'projector does not host budget-need arithmetic');
  ok(!/function paydayAllocation|function currentPeriodAction|function recommend\(/.test(src),
    'projector is not a second Forecast implementation');
}

console.log('\n=== B. live overlay operating answer matches direct Forecast ===');
{
  const canonical = clone(liveData);
  const cheqBefore = cashValue(canonical, 'chequing-a');
  const spendableBefore = independentSpendable(canonical.plan);
  const expectedSpendable = Math.round((spendableBefore - CASH_PURCHASE) * 100) / 100;
  const result = overlay(canonical, {
    tweaks: { 'chequing-a': cheqBefore - CASH_PURCHASE },
    transactions: [{
      id: 92001,
      account_id: 3001,
      date: LIVE_AS_OF,
      amount: CASH_PURCHASE,
      payee: 'SYNTHETIC STORE',
      is_pending: false,
      status: 'reviewed',
    }],
  });
  ok(result.data.liveOverlay && result.data.liveOverlay.applied === true,
    'cash-purchase overlay applied');
  const packet = OA.fromRefreshedState(result.data, {
    mode: 'live-overlay',
    baseline: canonical,
  });
  const advice = directRecommend(result.data, { mode: 'live-overlay' });
  assertCopiesForecast(packet, advice, 'live overlay');
  ok(packet.provenance.mode === 'live-overlay'
    && packet.provenance.trustedState === 'live-overlay-applied'
    && packet.provenance.overlayApplied === true
    && packet.provenance.writesCanonicalState === false,
    'live overlay provenance is live-overlay-applied and non-writing');
  ok(packet.asOf === LIVE_AS_OF, 'overlaid operating answer uses the live as-of');
  ok(near(independentSpendable(result.data.plan), expectedSpendable),
    'independent spendable cash falls by the $30 purchase');
  const beforeAdvice = directRecommend(canonical, { mode: 'live-overlay' });
  if (beforeAdvice.paydayAllocation && advice.paydayAllocation) {
    ok(near(
      beforeAdvice.paydayAllocation.available - advice.paydayAllocation.available,
      CASH_PURCHASE
    ) || advice.paydayAllocation.available <= beforeAdvice.paydayAllocation.available + 0.005,
      'direct Forecast available does not rise after the cash purchase');
    ok(near(packet.moneyAvailable.value, advice.paydayAllocation.available),
      'projected money available tracks that same Forecast available');
  }
  const figures = Live.forecastFrom(result.data, { baseline: canonical });
  ok(figures.operatingAnswer && figures.operatingAnswer.schema === OA.SCHEMA,
    'live-plan forecastFrom exposes the operating answer');
  ok(near(figures.startingCash, expectedSpendable),
    'live-plan startingCash still matches the independent spendable sum');
  filesUnchanged('live overlay library');
}

console.log('\n=== C. fail-closed overlay cannot look more precise ===');
{
  const canonical = clone(liveData);
  const datedAdvice = directRecommend(canonical, { mode: 'live-overlay' });
  const served = Live.serveCanonicalOrFixture(canonical, {
    ATLAS_LIVE_OVERLAY: 'fixture',
    ATLAS_LIVE_OVERLAY_FIXTURE: writeTempJson(tempDir(), 'stale.json', payloadFrom(canonical, {
      pendingCoverage: null,
      transactions: [],
    })),
    ATLAS_LIVE_OVERLAY_MAP: LIVE_MAP,
  });
  ok(served.liveOverlay && served.liveOverlay.applied === false,
    'unproven pending fails closed onto the dated opening');
  const packet = OA.fromRefreshedState(served, {
    mode: 'live-overlay',
    baseline: canonical,
  });
  const failedAdvice = directRecommend(served, { mode: 'live-overlay' });
  assertCopiesForecast(packet, failedAdvice, 'fail-closed overlay');
  ok(OA.actualsFrom(served, { mode: 'live-overlay' }) == null,
    'fail-closed overlay does not feed currentPeriodActuals into Forecast');
  ok(packet.provenance.trustedState === 'live-overlay-failed-closed',
    'fail-closed provenance is named');
  ok(precisionRank(packet.limitations.remainingClaim)
    <= precisionRank(datedAdvice.currentPeriodAction.remainingClaim),
    'fail-closed remainingClaim is not more precise than the dated opening');
  if (served.liveOverlay.operatingPlan === 'unavailable') {
    ok(packet.currentSpendingPermission.weekly == null
        && packet.currentSpendingPermission.remainingClaim === 'unavailable'
        && packet.extraDebtAllocation.status === 'unavailable'
        && packet.moneyAvailable.value == null,
      'later fail-closed overlay does not publish current spending permission, extra-debt, or money available');
    ok(packet.change && packet.change.changed === true,
      'withholding current claims from a stale opening is a Forecast-field change versus the dated opening');
  } else {
    ok(packet.limitations.remainingClaim === datedAdvice.currentPeriodAction.remainingClaim,
      'fail-closed remainingClaim matches dated-opening Forecast');
    ok(packet.change && packet.change.changed === false,
      'fail-closed Forecast fields are a zero/no-change versus the dated opening');
  }
  filesUnchanged('fail-closed overlay');
}

console.log('\n=== D. truncated actuals cannot claim precise remaining ===');
{
  const overlaid = clone(liveData);
  overlaid.liveOverlay = {
    applied: true,
    effectiveAsOf: overlaid.plan.opening.asOf,
    currentPeriodActuals: {
      schema: 'atlas-current-period-actuals/v1',
      observationAsOf: overlaid.plan.opening.asOf,
      coverageStart: overlaid.plan.opening.asOf,
      coverageThrough: overlaid.plan.opening.asOf,
      transactions: [],
      pendingCoverage: { complete: false },
      transactionCoverage: { complete: false, truncated: true },
    },
  };
  const packet = OA.fromRefreshedState(overlaid, { mode: 'live-overlay' });
  const advice = directRecommend(overlaid, { mode: 'live-overlay' });
  assertCopiesForecast(packet, advice, 'truncated actuals');
  ok(advice.currentPeriodAction.remainingClaim !== 'precise',
    'Forecast itself refuses precise remaining on truncated coverage');
  ok(packet.limitations.remainingClaim === advice.currentPeriodAction.remainingClaim,
    'projector does not upgrade truncated remainingClaim');
  ok(packet.limitations.remainingClaim !== 'precise',
    'truncated observation cannot make remaining look precise');
}

console.log('\n=== E. live and canonical provenance stay distinct ===');
{
  const canonical = clone(liveData);
  const livePacket = OA.fromRefreshedState(canonical, { mode: 'live-overlay' });
  const canonPacket = OA.fromRefreshedState(canonical, { mode: 'canonical' });
  ok(livePacket.provenance.mode === 'live-overlay', 'live mode names live-overlay');
  ok(canonPacket.provenance.mode === 'canonical', 'canonical mode names canonical');
  ok(livePacket.provenance.mode !== canonPacket.provenance.mode,
    'the two modes do not silently share provenance');

  const withActuals = clone(liveData);
  withActuals.liveOverlay = {
    applied: true,
    effectiveAsOf: withActuals.plan.opening.asOf,
    currentPeriodActuals: {
      schema: 'atlas-current-period-actuals/v1',
      observationAsOf: withActuals.plan.opening.asOf,
      coverageStart: withActuals.plan.opening.asOf,
      coverageThrough: withActuals.plan.opening.asOf,
      transactions: [],
      pendingCoverage: { complete: true, basis: O.PENDING_COVERAGE_BASIS },
      transactionCoverage: { complete: true, truncated: false },
    },
  };
  ok(OA.actualsFrom(withActuals, { mode: 'live-overlay' }) != null,
    'live-overlay mode may pass applied overlay actuals to Forecast');
  ok(OA.actualsFrom(withActuals, { mode: 'canonical' }) == null,
    'canonical mode never feeds live-overlay actuals into Forecast');
  const liveFromOverlay = OA.fromRefreshedState(withActuals, { mode: 'live-overlay' });
  const canonFromOverlay = OA.fromRefreshedState(withActuals, { mode: 'canonical' });
  ok(liveFromOverlay.provenance.overlayApplied === true, 'live mode records overlayApplied');
  ok(canonFromOverlay.provenance.overlayApplied === false,
    'canonical mode does not claim an overlay applied');
  ok(canonFromOverlay.limitations.remainingClaim
    === directRecommend(withActuals, { mode: 'canonical' }).currentPeriodAction.remainingClaim,
    'canonical remainingClaim ignores the in-memory overlay actuals');
}

console.log('\n=== F. zero/no-change is a valid Forecast result ===');
{
  const canonical = clone(liveData);
  const packet = OA.fromRefreshedState(canonical, {
    mode: 'canonical',
    baseline: canonical,
  });
  ok(packet.change && packet.change.changed === false,
    'identical canonical inputs are a Forecast no-change');
  ok((packet.change.fields || []).every(row => row.changed === false),
    'every compared Forecast field is unchanged');
}

console.log('\n=== F2. extra-debt target change is visible; baseline is not the write ===');
{
  const asOf = '2026-08-24';
  function mini(debts) {
    return {
      meta: { asOf },
      plan: {
        windowDays: 21,
        opening: { asOf },
        defaults: { targetBuffer: 0 },
        startingCash: { breakdown: [{ id: 'chequing-a', value: 5000 }] },
        nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
        income: [],
        obligations: [],
        bills: [],
        commitments: [],
      },
      debts,
    };
  }
  const higher = {
    id: 'cashback', label: 'Cash Back', balance: 100, rate: 0.1999,
    limit: 5000, pending: 0, pendingUnknown: false, secured: false,
    structure: 'Revolving credit',
  };
  const lower = {
    id: 'tdcc', label: 'TD Personal', balance: 50, rate: 0.1299,
    limit: 5000, pending: 0, pendingUnknown: false, secured: false,
    structure: 'Revolving credit',
  };
  const before = mini([clone(higher), clone(lower)]);
  const after = mini([Object.assign(clone(higher), { balance: 0 }), clone(lower)]);
  const beforeTarget = directRecommend(before, { mode: 'canonical' }).paydayAllocation.extraDebt.target;
  const afterTarget = directRecommend(after, { mode: 'canonical' }).paydayAllocation.extraDebt.target;
  ok(beforeTarget && beforeTarget.id === 'cashback',
    'direct Forecast targets the higher-rate revolving debt');
  ok(afterTarget && afterTarget.id === 'tdcc',
    'direct Forecast retargets after the higher-rate debt is cleared');
  const packet = OA.fromRefreshedState(after, {
    mode: 'canonical',
    baseline: before,
    writesCanonicalState: true,
  });
  ok(packet.provenance.writesCanonicalState === true
    && packet.provenance.trustedState === 'canonical-approved-write',
    'after-state provenance is the approved write');
  ok(packet.baselineProvenance
    && packet.baselineProvenance.writesCanonicalState === false
    && packet.baselineProvenance.trustedState !== 'canonical-approved-write',
    'baseline provenance is not claimed as the approved write');
  const targetField = (packet.change.fields || []).find(row =>
    row.field === 'extraDebtAllocation.target');
  ok(packet.change && packet.change.changed === true,
    'clearing the extra-debt target is a Forecast change');
  ok(targetField && targetField.changed === true
    && targetField.before === 'cashback' && targetField.after === 'tdcc',
    'the extra-debt target participates in the comparison');
}

console.log('\n=== G. canonical preview still does not publish the operating answer ===');
{
  const { payload, data } = trustedCase();
  const { preview } = C.previewFrom({
    provider: 'lunchmoney',
    payload,
    accountMap: pendingMap,
    data,
    identity,
    fetchedAt: payload.fetchedAt,
  });
  ok(!Object.prototype.hasOwnProperty.call(preview, 'operatingAnswer'),
    'preview has no operatingAnswer');
  ok(!Object.prototype.hasOwnProperty.call(preview, 'paydayAllocation'),
    'preview has no paydayAllocation');
  ok(!Object.prototype.hasOwnProperty.call(preview, 'recommend'),
    'preview has no recommend result');
}

console.log('\n=== H. approved canonical apply projects Forecast on the written document ===');
{
  const { payload, data } = trustedCase();
  const dir = tempDir();
  const dest = writeTempData(dir, data);
  const fixture = writeTempJson(dir, 'payload.json', payload);
  const { preview } = C.previewFrom({
    provider: 'lunchmoney',
    payload,
    accountMap: pendingMap,
    data,
    identity,
    fetchedAt: payload.fetchedAt,
  });
  const applied = runCli(CANONICAL_SCRIPT, [
    '--fixture', fixture, '--map', PENDING_MAP, '--data', dest,
    '--apply', '--approve', preview.previewId,
  ]);
  ok(applied.code === 0, 'approved apply exits 0', applied.stderr.trim());
  const printed = JSON.parse(applied.stdout);
  const written = JSON.parse(fs.readFileSync(dest, 'utf8'));
  ok(printed.operatingAnswer && printed.operatingAnswer.schema === OA.SCHEMA,
    'apply stdout includes the operating answer');
  ok(printed.operatingAnswer.provenance.mode === 'canonical'
    && printed.operatingAnswer.provenance.trustedState === 'canonical-approved-write'
    && printed.operatingAnswer.provenance.writesCanonicalState === true,
    'approved apply provenance is canonical-approved-write');
  const writtenAdvice = directRecommend(written, { mode: 'canonical' });
  assertCopiesForecast(printed.operatingAnswer, writtenAdvice, 'approved apply');
  ok(near(cashValue(written, 'chequing-b'), SYNTHETIC_OBSERVED),
    'written chequing-b is the independently previewed 390');
  ok(near(cashValue(written, 'chequing-a'), cashValue(data, 'chequing-a')),
    'approved apply left chequing-a unchanged');
  ok(near(cashValue(written, 'savings'), cashValue(data, 'savings')),
    'approved apply left savings unchanged');
  const expectedSpendable = independentSpendable(written.plan);
  ok(near(Forecast.startingCashAmount(written.plan), expectedSpendable),
    'written starting cash independently matches household chequing');
  ok(near(
    Forecast.startingCashAmount(data.plan) - Forecast.startingCashAmount(written.plan),
    SYNTHETIC_CURRENT - SYNTHETIC_OBSERVED
  ), 'Forecast starting cash falls by the independently written $10');
  ok(near(printed.operatingAnswer.moneyAvailable.value, writtenAdvice.paydayAllocation.available),
    'apply packet money available is that same Forecast available');
  ok(printed.operatingAnswer.change && typeof printed.operatingAnswer.change.changed === 'boolean',
    'apply packet reports whether Forecast fields changed');
  ok(printed.operatingAnswer.baselineProvenance
    && printed.operatingAnswer.baselineProvenance.writesCanonicalState === false
    && printed.operatingAnswer.baselineProvenance.trustedState !== 'canonical-approved-write',
    'apply packet does not label the pre-write baseline as the approved write');
  ok(C.identityProofLooksSanitized(printed), 'apply operating answer is sanitized');
  ok(!/"payee"\s*:/.test(applied.stdout) && !/"providerAccountId"\s*:/.test(applied.stdout),
    'apply stdout has no payee or provider account id');
}

console.log('\n=== I. live-plan CLI prints the operating answer and does not write ===');
{
  const dir = tempDir();
  const canonical = clone(liveData);
  const fixture = writeTempJson(dir, 'fixture.json', payloadFrom(canonical, {
    tweaks: { 'chequing-a': cashValue(canonical, 'chequing-a') - CASH_PURCHASE },
  }));
  const cli = runCli(LIVE_SCRIPT, ['--fixture', fixture, '--map', LIVE_MAP, '--data', DATA]);
  ok(cli.code === 0, 'live-plan CLI exits 0', cli.stderr.trim());
  const parsed = JSON.parse(cli.stdout);
  ok(parsed.writesCanonicalState === false, 'live-plan CLI remains non-writing');
  ok(parsed.operatingAnswer && parsed.operatingAnswer.schema === OA.SCHEMA,
    'live-plan CLI prints the operating answer');
  ok(parsed.forecast && parsed.forecast.operatingAnswer,
    'live-plan forecast summary carries the same operating answer');
  ok(parsed.operatingAnswer.provenance.mode === 'live-overlay',
    'CLI operating answer provenance is live-overlay');
  const result = overlay(canonical, {
    tweaks: { 'chequing-a': cashValue(canonical, 'chequing-a') - CASH_PURCHASE },
  });
  const advice = directRecommend(result.data, { mode: 'live-overlay' });
  ok(near(parsed.operatingAnswer.moneyAvailable.value, advice.paydayAllocation.available),
    'CLI money available matches direct Forecast on the same overlay');
  ok(parsed.operatingAnswer.change && parsed.operatingAnswer.baselineProvenance,
    'CLI compares the overlaid Forecast result to the dated opening');
  filesUnchanged('live-plan CLI');
}

console.log('\n=== J. incumbents remain ===');
{
  const liveSrc = fs.readFileSync(LIVE_SCRIPT, 'utf8');
  const refreshSrc = fs.readFileSync(CANONICAL_SCRIPT, 'utf8');
  ok(/function fromObservation/.test(liveSrc), 'live overlay seam remains');
  ok(/previewId|approve/.test(refreshSrc), 'canonical preview/approve writer remains');
  ok(!/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(refreshSrc)
    && !/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(liveSrc),
    'neither refresh script issues a Lunch Money write method');
  ok(!/setInterval|node-cron|cron\.schedule/.test(refreshSrc)
    && !/setInterval|node-cron|cron\.schedule/.test(liveSrc),
    'neither refresh script adds a scheduler');
  ok(!fs.existsSync(path.join(ROOT, 'docs', 'AF_REFRESH_TRUSTED_STATE_LOOP_PLAN.md')),
    'temporary AF-REFRESH campaign plan is retired after closed-loop acceptance');
}

const afterTree = hashTree();
ok(afterTree.data === beforeTree.data
  && afterTree.positions === beforeTree.positions
  && afterTree.snapshots === beforeTree.snapshots,
  'this suite left live canonical files byte-identical');

if (failures) {
  console.log(`\nFAILED — ${failures} assertion${failures === 1 ? '' : 's'}`);
  process.exit(1);
}
console.log('\nAll AF-REFRESH-05 operating-answer proofs passed.');
