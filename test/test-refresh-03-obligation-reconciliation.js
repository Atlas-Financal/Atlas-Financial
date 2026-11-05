'use strict';
/* AF-REFRESH-03 — one trusted current-period obligation-reconciliation receipt.
 *
 * Independent of reconciliationReceipt for identity/settlement reconstruction:
 * a separately built payee+account+direction+date compatibility matrix decides
 * which occurrence/transaction pairs are unique, ambiguous, or double-consumed.
 * Amount/date/account constraints are checked on that matrix, not by calling
 * the receipt function twice. Canonical no-write is a file-tree hash.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const O = require('../scripts/provider-observe.js');
const Forecast = require('../public/forecast.js');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'lunchmoney-sample.json');
const SAMPLE_MAP = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'provider-account-map.json');
const PENDING = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'lunchmoney-pending-acceptance.json');
const PENDING_MAP = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'pending-account-map.json');
const AUTO = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'automatic-payment-settlement.json');
const IDENTITY = path.join(ROOT, 'docs', 'connectivity', 'transaction-identity.json');
const DATA = path.join(ROOT, 'data.json');
const POSITIONS = path.join(ROOT, 'docs', 'positions.csv');
const PERIODS = path.join(ROOT, 'public', 'periods.json');
const SNAPSHOTS = path.join(ROOT, 'snapshots');
const OBSERVE = path.join(ROOT, 'scripts', 'provider-observe.js');
const FORECAST_JS = path.join(ROOT, 'public', 'forecast.js');
const OBSERVE_JS = path.join(ROOT, 'scripts', 'provider-observe.js');
const RECONCILE_JS = path.join(ROOT, 'scripts', 'reconcile.js');
const LIVE_JS = path.join(ROOT, 'scripts', 'live-plan.js');
const CANONICAL_JS = path.join(ROOT, 'scripts', 'canonical-refresh.js');
const CMAW_ID = 'uniondues-aug15-outstanding';
const AUTO_IDS = [
  'bcaa-aug15-outstanding',
  'icbc-aug15-outstanding',
  'resp-aug15-outstanding',
];
const SCHEDULE_TRUST = 'schedule-trust-on-due';
const NAMED_SCHEDULE_TRUST_IDS = new Set([
  'youtube-premium',
  'spotify',
  'chatgpt-plus-dale',
  'chatgpt-plus-amanda',
  'icloud-storage',
]);
function isScheduleTrustRow(row) {
  return !!(row && (row.postingDateRelation === SCHEDULE_TRUST
    || row.settlesWhen === SCHEDULE_TRUST
    || row.identity === SCHEDULE_TRUST));
}

let failures = 0;
function ok(cond, label, detail) {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}
function clone(x) { return JSON.parse(JSON.stringify(x)); }
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
function load(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function evidenceFp(txId) {
  return crypto.createHash('sha256')
    .update('atlas-evidence:lunchmoney:tx:' + String(txId))
    .digest('hex');
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function independentRelation(scheduled, posted, weekendRule) {
  if (scheduled === posted) return 'same-day';
  if (!weekendRule) return null;
  const weekday = new Date(scheduled + 'T00:00:00Z').getUTCDay();
  const next = weekday === 6 ? addDays(scheduled, 2)
    : weekday === 0 ? addDays(scheduled, 1) : null;
  return next === posted ? 'weekend-next-business-day' : null;
}
function independentScheduledDates(posted, weekendRule) {
  const dates = [posted];
  if (weekendRule) dates.push(addDays(posted, -1), addDays(posted, -2));
  return dates.filter((date, i) => date && dates.indexOf(date) === i
    && independentRelation(date, posted, weekendRule));
}
function payeeHit(payee, pattern) {
  return String(payee || '').toLowerCase().includes(String(pattern || '').toLowerCase());
}
function rulePatterns(rule) {
  return [].concat((rule && rule.payeePatterns) || [], rule && rule.payeePattern ? [rule.payeePattern] : [])
    .map(v => String(v).trim()).filter(Boolean);
}

// Second method: rebuild compatible occurrence↔transaction pairs from
// normalized transactions, the account map, identity aliases, and Forecast
// schedule expansion. This is not reconciliationReceipt and not
// representedEventCandidates.
function independentMatrix(payload, accountMap, identity, plan) {
  const normalized = O.normalizeLunchMoneyPayload(payload, payload.fetchedAt);
  if (normalized.transactionWindow && normalized.transactionWindow.complete === false) {
    return [];
  }
  const collapsed = O.collapseByProviderTransactionId(normalized.transactions);
  const rows = [];
  for (const tx of collapsed.transactions) {
    if (!tx || tx.pending === true || tx.contradictoryEvidence === true) continue;
    const mapping = O.mappingFor(accountMap, tx.providerAccountId);
    if (!mapping || !mapping.canonical || !mapping.canonical.id) continue;
    const amount = O.lunchMoneyDebitAmount(tx.amount);
    for (const rule of identity.rules || []) {
      if (!rule || !rule.eventId) continue;
      if (rule.atlasAccountId && mapping.canonical.id !== rule.atlasAccountId) continue;
      if (!rulePatterns(rule).some(pattern => payeeHit(tx.payee, pattern))) continue;
      if (rule.direction === 'credit' && !(amount < 0)) continue;
      if (rule.direction === 'debit' && !(amount > 0)) continue;
      const weekend = rule.postingDateRule === 'same-day-or-weekend-next-business-day';
      for (const scheduled of independentScheduledDates(tx.date, weekend)) {
        const events = Forecast.expandEvents({
          income: plan.income || [],
          obligations: plan.obligations || [],
          bills: plan.bills || [],
          commitments: plan.commitments || [],
          startingCash: plan.startingCash,
        }, scheduled, scheduled, {}).filter(e => e && e.id === rule.eventId
          && e.date === scheduled && e.kind !== 'noncash');
        if (events.length !== 1) continue;
        const relation = independentRelation(scheduled, tx.date, weekend);
        if (!relation) continue;
        rows.push({
          eventId: rule.eventId,
          date: scheduled,
          txId: String(tx.providerTransactionId),
          accountId: mapping.canonical.id,
          relation,
          amount,
        });
      }
    }
  }
  return rows;
}

function independentUnique(matrix) {
  const byEvent = new Map();
  for (const row of matrix) {
    const key = row.eventId + '@' + row.date;
    const list = byEvent.get(key) || [];
    list.push(row);
    byEvent.set(key, list);
  }
  const unique = [];
  const ambiguousKeys = new Set();
  for (const [key, list] of byEvent) {
    if (list.length === 1) unique.push(list[0]);
    else ambiguousKeys.add(key);
  }
  const byTx = new Map();
  for (const row of unique) {
    const list = byTx.get(row.txId) || [];
    list.push(row);
    byTx.set(row.txId, list);
  }
  const uniqueOnce = [];
  const doubleTx = new Set();
  for (const row of unique) {
    if ((byTx.get(row.txId) || []).length > 1) {
      doubleTx.add(row.txId);
      ambiguousKeys.add(row.eventId + '@' + row.date);
      continue;
    }
    uniqueOnce.push(row);
  }
  return { unique: uniqueOnce, ambiguousKeys, doubleTx, byEvent };
}

const samplePayload = load(SAMPLE);
const sampleMap = load(SAMPLE_MAP);
const pendingPayload = load(PENDING);
const pendingMap = load(PENDING_MAP);
const autoPayPayload = load(AUTO);
const identity = load(IDENTITY);
const data = load(DATA);
const periods = load(PERIODS);

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
    endDate: '2026-08-19',
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

function readyAutoPayPayload(opts) {
  opts = opts || {};
  const out = withCompleteCoverage(pendingPayload, opts.window);
  out.fetchedAt = opts.fetchedAt || '2026-08-19T16:00:00.000Z';
  let extra = (autoPayPayload.transactions || []).map(remapAutoTx);
  if (opts.omitCmaw) extra = extra.filter(tx => tx.id !== 8104);
  if (opts.omitBcaa) extra = extra.filter(tx => tx.id !== 8101);
  if (opts.omitUnmatched) extra = extra.filter(tx => tx.id !== 8199);
  if (opts.duplicateBcaa) {
    const bcaa = extra.find(tx => tx.id === 8101);
    extra.push(Object.assign({}, bcaa, { id: 8121 }));
  }
  if (opts.unrelatedCmawLabel) {
    extra.push({
      id: 8188,
      account_id: 3001,
      date: '2026-08-17',
      amount: 25,
      is_pending: false,
      payee: 'Union dues category lookalike',
    });
  }
  out.transactions = (out.transactions || []).concat(extra);
  return out;
}

function observeWith(payload, accountMap, extra) {
  extra = extra || {};
  return O.observe({
    provider: 'lunchmoney',
    payload,
    accountMap,
    data: extra.data || data,
    identity: extra.identity || identity,
    fetchedAt: payload.fetchedAt,
  });
}

function receiptOf(payload, accountMap, extra) {
  return observeWith(payload, accountMap, extra).obligationReconciliationReceipt;
}

function rowById(receipt, id) {
  return ((receipt && receipt.occurrences) || []).find(row => row && row.id === id) || null;
}

const beforeTree = hashTree();

console.log('=== A. observation packet not ready cannot produce a trusted reconciliation ===');
{
  const report = observeWith(samplePayload, sampleMap);
  const receipt = report.obligationReconciliationReceipt;
  ok(report.observationReceipt && report.observationReceipt.readyForReconciliation === false,
    'sample observation is not ready for reconciliation');
  ok(receipt.trusted === false && receipt.failClosedKind === 'observation-not-ready',
    'reconciliation fails closed as observation-not-ready');
  ok((receipt.occurrences || []).length === 0,
    'not-ready packets do not publish occurrence classification as current truth');
  ok(receipt.observationReadyForReconciliation === false,
    'receipt distinguishes observation unreadiness from unresolved obligations');
  ok((receipt.failClosedReasons || []).length > 0,
    'not-ready receipt names fail-closed reasons from the observation gate');
}

console.log('\n=== B. ready packet with identity-complete auto-pay evidence ===');
{
  const payload = readyAutoPayPayload();
  const report = observeWith(payload, pendingMap);
  const receipt = report.obligationReconciliationReceipt;
  const matrix = independentMatrix(payload, pendingMap, identity, data.plan);
  const indep = independentUnique(matrix);
  ok(report.observationReceipt.readyForReconciliation === true,
    'constructed auto-pay packet is ready for reconciliation');
  ok(receipt.trusted === true && receipt.failClosedKind == null,
    'ready packet produces a trusted reconciliation result');
  ok(receipt.observationFingerprintDigest === report.observationReceipt.fingerprintDigest,
    'reconciliation receipt consumes the observation fingerprint');
  ok(receipt.canonicalStateChanged === false && receipt.writesCanonicalState === false,
    'receipt declares no canonical write or change');
  ok(receipt.forecastPlannerInvoked === false,
    'receipt declares no Forecast planner invocation');

  for (const id of AUTO_IDS) {
    const row = rowById(receipt, id);
    const hit = indep.unique.find(r => r.eventId === id);
    ok(!!row && row.settlement === 'represented' && !!hit,
      `${id} is independently uniquely compatible and receipt-represented`,
      row && row.settlement);
    ok(hit && row && row.evidenceFingerprint === evidenceFp(hit.txId),
      `${id} evidence fingerprint independently matches the consumed transaction`);
    ok(hit && row && row.atlasAccountId === hit.accountId && hit.accountId === 'chequing-a',
      `${id} account constraint independently agrees (chequing-a)`);
    ok(hit && row && row.postingDateRelation === hit.relation
      && hit.relation === 'weekend-next-business-day',
      `${id} date relation independently agrees`);
    ok(hit && Math.abs(Number(row.observedAmount) - Number(hit.amount)) < 0.005,
      `${id} observed amount independently agrees with the matrix`);
  }
}

console.log('\n=== C. one occurrence consumes one transaction; no transaction settles two ===');
{
  const payload = readyAutoPayPayload();
  const receipt = receiptOf(payload, pendingMap);
  const matrix = independentUnique(independentMatrix(payload, pendingMap, identity, data.plan));
  const represented = (receipt.occurrences || []).filter(r => r.settlement === 'represented'
    && !isScheduleTrustRow(r));
  const fps = represented.map(r => r.evidenceFingerprint);
  ok(fps.every(Boolean) && fps.length === new Set(fps).size,
    'represented bank-payee evidence fingerprints are unique');
  ok(receipt.oneOccurrenceOneTransaction === true, 'receipt reports one-occurrence-one-transaction');
  ok(receipt.noTransactionConsumedTwice === true, 'receipt reports no transaction consumed twice');
  ok(matrix.doubleTx.size === 0, 'independent matrix has no double-consumed transaction');
  ok(represented.length === matrix.unique.filter(r => AUTO_IDS.indexOf(r.eventId) !== -1).length,
    'independent unique auto-pay matches equal represented auto-pay rows');
  ok((receipt.occurrences || []).filter(isScheduleTrustRow).every(row =>
      row.settlement === 'represented'
      && !row.evidenceFingerprint
      && NAMED_SCHEDULE_TRUST_IDS.has(row.id)),
    'named schedule-trust exceptions are not bank-payee auto-pay identities');
}

console.log('\n=== D. cancelled CMAW dues are not a modeled occurrence ===');
{
  const payload = readyAutoPayPayload({ omitCmaw: true, unrelatedCmawLabel: true });
  const receipt = receiptOf(payload, pendingMap);
  const matrix = independentUnique(independentMatrix(payload, pendingMap, identity, data.plan));
  const cmaw = rowById(receipt, CMAW_ID);
  const blob = JSON.stringify(periods);
  ok(/25/.test(blob) && /Union dues|union/i.test(blob),
    'historical periods.json still contains Union dues actuals');
  ok(!matrix.unique.some(r => r.eventId === CMAW_ID),
    'independent matrix has no identity-complete CMAW match');
  ok(!cmaw,
    'cancelled CMAW dues are not a current-cycle occurrence');
  ok(!(receipt.occurrences || []).some(row => row.id === CMAW_ID
      || /cmaw|union dues/i.test(row.label || '')),
    'lookalike payee and historical actuals do not invent a CMAW bill');
}

console.log('\n=== E. not-observed is never unpaid; unresolved is distinct from not-ready ===');
{
  const payload = readyAutoPayPayload({ omitCmaw: true, omitUnmatched: true });
  const receipt = receiptOf(payload, pendingMap);
  const settlements = (receipt.occurrences || []).map(r => r.settlement);
  ok(receipt.trusted === true, 'ready packet with unverified rows is still a trusted run');
  ok(settlements.indexOf('unpaid') === -1 && settlements.indexOf('paid') === -1,
    'receipt never uses a paid/unpaid boolean');
  ok(!rowById(receipt, CMAW_ID),
    'cancelled CMAW dues are absent, not labelled unpaid');
  ok(receipt.failClosedKind == null && receipt.observationReadyForReconciliation === true,
    'unresolved obligations are not the observation-not-ready failure mode');
}

console.log('\n=== F. ambiguous compatible candidates remain ambiguous ===');
{
  const payload = readyAutoPayPayload({ duplicateBcaa: true });
  const receipt = receiptOf(payload, pendingMap);
  const matrix = independentUnique(independentMatrix(payload, pendingMap, identity, data.plan));
  const bcaa = rowById(receipt, 'bcaa-aug15-outstanding');
  ok(matrix.ambiguousKeys.has('bcaa-aug15-outstanding@2026-08-16'),
    'independent matrix treats duplicate BCAA hits as ambiguous');
  ok(bcaa && bcaa.settlement === 'ambiguous',
    'receipt keeps duplicate BCAA candidates ambiguous rather than selecting one',
    bcaa && bcaa.settlement);
  ok(bcaa && bcaa.candidateCount === 2, 'ambiguous BCAA names two candidates');
  ok(!(bcaa && bcaa.evidenceFingerprint),
    'ambiguous BCAA does not choose a single evidence fingerprint');
}

console.log('\n=== G. unmatched trusted household cash is surfaced, not invented ===');
{
  const payload = readyAutoPayPayload();
  const receipt = receiptOf(payload, pendingMap);
  ok((receipt.unmatchedCashEvidence || []).length >= 1,
    'unmatched household-cash debit is listed');
  const unmatched = receipt.unmatchedCashEvidence.find(row =>
    Math.abs(Number(row.amount) - 100) < 0.005);
  ok(!!unmatched && unmatched.accountRole === 'household-cash',
    'the $100 unmatched debit is unresolved cash evidence, not a new bill');
  ok(!(receipt.occurrences || []).some(row => row.id === 'fixture-unrelated-debit'
    || Math.abs(Number(row.plannedAmount) - 100) < 0.005 && row.id.indexOf('unmatched') !== -1),
    'unmatched cash is not invented into a modeled occurrence');
  ok(unmatched && unmatched.evidenceFingerprint === evidenceFp('8199'),
    'unmatched evidence fingerprint independently matches fixture tx 8199');
}

console.log('\n=== H. one transaction cannot settle two occurrences ===');
{
  const payload = withCompleteCoverage(pendingPayload);
  payload.fetchedAt = '2026-08-19T16:00:00.000Z';
  payload.transactions = (payload.transactions || []).concat([{
    id: 9001,
    account_id: 3001,
    date: '2026-08-17',
    amount: 10,
    is_pending: false,
    payee: 'SYNTHETIC SHARED PAYEE',
  }]);
  const cloned = clone(data);
  cloned.plan.bills = cloned.plan.bills.concat([
    {
      id: 'synth-a', label: 'synthetic A', frequency: 'once', date: '2026-08-15',
      amount: 10, confidence: 'confirmed',
    },
    {
      id: 'synth-b', label: 'synthetic B', frequency: 'once', date: '2026-08-16',
      amount: 10, confidence: 'confirmed',
    },
  ]);
  const ident = clone(identity);
  ident.rules = ident.rules.concat([
    {
      eventId: 'synth-a', payeePattern: 'SYNTHETIC SHARED PAYEE',
      atlasAccountId: 'chequing-a', direction: 'debit',
      postingDateRule: 'same-day-or-weekend-next-business-day',
    },
    {
      eventId: 'synth-b', payeePattern: 'SYNTHETIC SHARED PAYEE',
      atlasAccountId: 'chequing-a', direction: 'debit',
      postingDateRule: 'same-day-or-weekend-next-business-day',
    },
  ]);
  const receipt = receiptOf(payload, pendingMap, { data: cloned, identity: ident });
  const matrix = independentUnique(independentMatrix(payload, pendingMap, ident, cloned.plan));
  ok(matrix.doubleTx.has('9001'),
    'independent matrix sees one transaction compatible with two occurrences');
  const a = rowById(receipt, 'synth-a');
  const b = rowById(receipt, 'synth-b');
  ok(a && a.settlement === 'ambiguous' && b && b.settlement === 'ambiguous',
    'both synthetic occurrences stay ambiguous instead of sharing the transaction',
    [a && a.settlement, b && b.settlement].join(','));
  ok(receipt.noTransactionConsumedTwice === true
    || (a && a.settlement !== 'represented' && b && b.settlement !== 'represented'),
    'the shared transaction does not uniquely represent either occurrence');
}

console.log('\n=== I. identical trusted evidence produces the same receipt ===');
{
  const payload = readyAutoPayPayload();
  const first = receiptOf(payload, pendingMap);
  const second = receiptOf(clone(payload), pendingMap);
  ok(JSON.stringify(first) === JSON.stringify(second),
    'two observes of identical evidence share one reconciliation receipt');
}

console.log('\n=== J. outside-coverage is distinct from unverified ===');
{
  const payload = readyAutoPayPayload({
    omitCmaw: true,
    omitBcaa: true,
    omitUnmatched: true,
    window: { startDate: '2026-08-18', endDate: '2026-08-19' },
  });
  const receipt = receiptOf(payload, pendingMap);
  const bcaa = rowById(receipt, 'bcaa-aug15-outstanding');
  ok(bcaa && bcaa.settlement === 'outside-coverage',
    'Aug 16 BCAA is outside an Aug 18–19 observation window',
    bcaa && bcaa.settlement);
  ok(!rowById(receipt, CMAW_ID),
    'cancelled CMAW dues are not an outside-coverage occurrence');
}

console.log('\n=== K. not-ready packet with matching txs still does not trust classification ===');
{
  const payload = clone(autoPayPayload);
  const report = observeWith(payload, sampleMap);
  const receipt = report.obligationReconciliationReceipt;
  ok(report.observationReceipt.readyForReconciliation === false,
    'auto-pay fixture mapped without savings is not ready');
  ok(receipt.trusted === false && (receipt.occurrences || []).length === 0,
    'matcher-compatible txs in an unready packet do not publish represented rows');
}

console.log('\n=== L. CLI --reconciliation-receipt is sanitized and does not write ===');
{
  const payloadPath = path.join(ROOT, 'docs', 'connectivity', 'fixtures',
    'lunchmoney-pending-acceptance.json');
  const printed = JSON.parse(execFileSync(process.execPath, [
    OBSERVE,
    '--provider', 'lunchmoney',
    '--fixture', payloadPath,
    '--map', PENDING_MAP,
    '--reconciliation-receipt',
  ], { cwd: ROOT, encoding: 'utf8' }));
  ok(printed.schema === O.RECONCILIATION_RECEIPT_SCHEMA,
    'CLI --reconciliation-receipt uses the obligation-reconciliation schema');
  ok(O.reconciliationReceiptLooksSanitized(printed), 'CLI receipt is sanitized');
  const blob = JSON.stringify(printed);
  ok(!/"providerAccountId"/.test(blob) && !/"providerTransactionId"/.test(blob),
    'CLI receipt has no provider account or transaction ids');
  ok(!/CMAWLOCAL1995|SEASPAN|Bcaa-adv|8101|3001/.test(blob),
    'CLI receipt has no raw payees or fixture provider ids');
  ok(!Object.prototype.hasOwnProperty.call(printed, 'recommend')
    && !Object.prototype.hasOwnProperty.call(printed, 'safeToSpend')
    && !Object.prototype.hasOwnProperty.call(printed, 'paydayAllocation'),
    'CLI receipt has no Forecast planning fields');
}

console.log('\n=== M. canonical files are unchanged; incumbents remain ===');
{
  const after = hashTree();
  ok(after.data === beforeTree.data, 'data.json bytes unchanged');
  ok(after.positions === beforeTree.positions, 'positions.csv bytes unchanged');
  ok(after.periods === beforeTree.periods, 'periods.json bytes unchanged');
  ok(after.snapshots === beforeTree.snapshots, 'snapshots/ bytes unchanged');
  const observeSrc = fs.readFileSync(OBSERVE_JS, 'utf8');
  const forecastSrc = fs.readFileSync(FORECAST_JS, 'utf8');
  ok(/function reconcile/.test(fs.readFileSync(RECONCILE_JS, 'utf8')),
    'scripts/reconcile.js remains the compare authority');
  ok(/function overlayLiveState|overlayLiveState/.test(fs.readFileSync(LIVE_JS, 'utf8')),
    'live-plan overlay remains');
  ok(/previewId|approve/.test(fs.readFileSync(CANONICAL_JS, 'utf8')),
    'canonical-refresh preview/approve writer remains');
  ok(/representedEventCandidates/.test(observeSrc),
    'incumbent representedEventCandidates matcher remains');
  const recSrc = /function reconciliationReceipt\([\s\S]*?\nfunction observationsFromMappedAccount/
    .exec(observeSrc);
  ok(!!recSrc, 'reconciliationReceipt is a distinct function');
  ok(!/Forecast\.recommend|paydayAllocation/.test(recSrc[0]),
    'reconciliationReceipt does not call Forecast.recommend or paydayAllocation');
  ok(/currentPeriodObligationStates/.test(recSrc[0]),
    'reconciliationReceipt consumes Forecast.currentPeriodObligationStates');
  ok(/paydayPeriodOrigin/.test(recSrc[0]),
    'reconciliationReceipt preserves the current payday-period origin');
  ok(/function currentPeriodObligationStates/.test(forecastSrc),
    'Forecast.currentPeriodObligationStates exists');
  const obligationFn = /function currentPeriodObligationStates[\s\S]*?\n  function currentPeriodAction/.exec(forecastSrc);
  ok(!!obligationFn, 'currentPeriodObligationStates is a distinct Forecast function');
  ok(obligationFn && !/paydayAllocation\(/.test(obligationFn[0]),
    'currentPeriodObligationStates does not compute paydayAllocation');
}

console.log('\n=== N. ready packet count identity ===');
{
  const payload = readyAutoPayPayload();
  const receipt = receiptOf(payload, pendingMap);
  const counted = receipt.counts.represented + receipt.counts.upcoming
    + receipt.counts.unverified + receipt.counts.ambiguous + receipt.counts.outsideCoverage;
  ok(counted === receipt.counts.coveredModeledOccurrences,
    'settlement counts sum to covered modeled occurrences');
  ok(receipt.counts.represented === (receipt.occurrences || [])
    .filter(r => r.settlement === 'represented').length,
    'represented count matches occurrence rows');
  ok(receipt.counts.unmatchedCashEvidence === (receipt.unmatchedCashEvidence || []).length,
    'unmatched count matches unmatched rows');
}

console.log('\n=== O. payday-period origin keeps a late-posting recurring bill visible ===');
{
  const AS_OF = '2026-09-16';
  const DUE = '2026-09-15';
  const payrollAnchor = '2026-08-14';
  function independentBiweekly(anchor, start, end) {
    const dates = [];
    let cursor = anchor;
    while (cursor < start) cursor = addDays(cursor, 14);
    while (cursor <= end) {
      dates.push(cursor);
      cursor = addDays(cursor, 14);
    }
    return dates;
  }
  function independentMonthlyDay(day, firstDue, start, end) {
    const dates = [];
    let cursor = start.slice(0, 8) + String(day).padStart(2, '0');
    if (cursor < start) {
      const [y, m] = start.split('-').map(Number);
      const nextM = m === 12 ? 1 : m + 1;
      const nextY = m === 12 ? y + 1 : y;
      cursor = `${nextY}-${String(nextM).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    while (cursor <= end) {
      if (!firstDue || cursor >= firstDue) dates.push(cursor);
      const [y, m] = cursor.split('-').map(Number);
      const nextM = m === 12 ? 1 : m + 1;
      const nextY = m === 12 ? y + 1 : y;
      cursor = `${nextY}-${String(nextM).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return dates;
  }
  const lookbackStart = addDays(AS_OF, -60);
  const paydayDates = []
    .concat(independentBiweekly(payrollAnchor, lookbackStart, addDays(AS_OF, 40)))
    .concat(independentMonthlyDay(15, '2026-09-15', lookbackStart, addDays(AS_OF, 40)))
    .concat(independentMonthlyDay(31, null, lookbackStart, addDays(AS_OF, 40)));
  const previousPayday = paydayDates.filter(d => d < AS_OF).sort().pop();
  const nextPayday = paydayDates.filter(d => d >= AS_OF).sort()[0];
  ok(previousPayday === DUE, 'independent last payday before 2026-09-16 is 2026-09-15',
    previousPayday);
  ok(nextPayday === '2026-09-25', 'independent next payday on/after 2026-09-16 is 2026-09-25',
    nextPayday);
  const bcaaRow = (data.plan.bills || []).find(b => b && b.id === 'bcaa');
  ok(!!bcaaRow && bcaaRow.frequency === 'monthly' && Number(bcaaRow.day) === 15
    && bcaaRow.firstDue === DUE,
    'canonical BCAA is monthly on the 15th with firstDue 2026-09-15');
  ok(DUE >= previousPayday && DUE < nextPayday,
    'BCAA 2026-09-15 sits inside the current payday period');
  const truncated = Forecast.currentPeriodObligationStates(data.plan, AS_OF, {
    representedEvents: [{ id: 'bcaa', date: DUE }],
  });
  ok(!(truncated.bills || []).some(b => b && b.id === 'bcaa' && b.date === DUE),
    'default obligation-state origin on the unchanged plan still omits 2026-09-15 BCAA');
  const payload = withCompleteCoverage(pendingPayload, {
    startDate: DUE,
    endDate: AS_OF,
  });
  payload.fetchedAt = '2026-09-16T16:00:00.000Z';
  payload.accounts = (payload.accounts || []).map(account => Object.assign({}, account, {
    updated_at: '2026-09-16T15:55:00.000Z', balance_last_update: '2026-09-16T15:55:00.000Z',
  }));
  payload.transactions = (payload.transactions || []).concat([{
    id: 9101,
    account_id: 3001,
    date: DUE,
    amount: 82.96,
    is_pending: false,
    payee: 'Bcaa-adv',
  }]);
  const report = observeWith(payload, pendingMap);
  const receipt = report.obligationReconciliationReceipt;
  const matrix = independentUnique(independentMatrix(payload, pendingMap, identity, data.plan));
  const hit = matrix.unique.find(r => r.eventId === 'bcaa' && r.date === DUE);
  const row = (receipt.occurrences || []).find(r => r && r.id === 'bcaa' && r.date === DUE);
  const fp = evidenceFp('9101');
  const unmatchedFp = ((receipt.unmatchedCashEvidence || [])
    .map(item => item && item.evidenceFingerprint));
  ok(report.observationReceipt && report.observationReceipt.readyForReconciliation === true,
    'Sep 16 packet with required-cash coverage is ready for reconciliation');
  ok(!!hit && hit.accountId === 'chequing-a' && hit.relation === 'same-day',
    'independent matrix uniquely matches BCAA@2026-09-15 on chequing-a same-day');
  ok(!!row && row.settlement === 'represented',
    'receipt still lists the 2026-09-15 BCAA occurrence as represented',
    row && row.settlement);
  ok(row && row.evidenceFingerprint === fp,
    'represented BCAA keeps the posting evidence fingerprint');
  ok(unmatchedFp.indexOf(fp) === -1,
    'represented BCAA evidence is not also listed as unmatched cash');
  ok(!!row || unmatchedFp.indexOf(fp) !== -1,
    'identity-complete BCAA evidence cannot vanish from both occurrence rows and unmatched evidence');
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll AF-REFRESH-03 obligation-reconciliation checks passed.');
