'use strict';
/* Owner-triggered closed-loop refresh acceptance.
 *
 * Composes the incumbent observation receipt, obligation-reconciliation
 * receipt, canonical preview, live overlay, Forecast operating answer,
 * and refresh-trust packet into one sanitized packet. It does not
 * recalculate Forecast, invent settlement, or write canonical state.
 *
 *   node scripts/refresh-loop-acceptance.js --fixture <file>
 *   node scripts/refresh-loop-acceptance.js --live
 *
 * Default is read-only. There is no --apply. Identical provider evidence
 * is observed twice in-process; that replay must be a deterministic no-op.
 * A second live GET is not required for the replay proof.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const O = require('./provider-observe.js');
const C = require('./canonical-refresh.js');
const Live = require('./live-plan.js');
const OA = require('./operating-answer.js');
const RT = require('./refresh-trust.js');
const Forecast = require('../public/forecast.js');

const ROOT = path.join(__dirname, '..');
const SCHEMA = 'atlas-refresh-loop-acceptance/v1';
const DEFAULT_DATA = path.join(ROOT, 'data.json');
const DEFAULT_POSITIONS = path.join(ROOT, 'docs', 'positions.csv');
const DEFAULT_PERIODS = path.join(ROOT, 'public', 'periods.json');
const DEFAULT_SNAPSHOTS = path.join(ROOT, 'snapshots');
const DEFAULT_IDENTITY = path.join(ROOT, 'docs', 'connectivity', 'transaction-identity.json');
const POSTED_CASH = ['chequing-a', 'chequing-b', 'savings'];

function fail(message) {
  const err = new Error(message);
  err.code = 'refresh-loop-acceptance-failed';
  throw err;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hashTree(paths) {
  const snapDir = paths.snapshots;
  const snapNames = fs.existsSync(snapDir)
    ? fs.readdirSync(snapDir).filter(name => name.endsWith('.json')).sort()
    : [];
  const snap = snapNames.map(name => name + ':' + hashFile(path.join(snapDir, name))).join('|');
  return {
    data: hashFile(paths.data),
    positions: hashFile(paths.positions),
    periods: fs.existsSync(paths.periods) ? hashFile(paths.periods) : null,
    snapshots: crypto.createHash('sha256').update(snap).digest('hex'),
  };
}

function loadIdentity(file) {
  if (!file || !fs.existsSync(file)) return { rules: [], billPaymentPayees: [] };
  return loadJson(file);
}

function parseArgs(argv) {
  const out = {
    live: false,
    fixture: null,
    map: null,
    data: DEFAULT_DATA,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') out.live = true;
    else if (a === '--fixture') out.fixture = argv[++i];
    else if (a === '--map') out.map = argv[++i];
    else if (a === '--data') out.data = argv[++i];
    else if (a === '--apply' || a === '--approve') {
      fail('refresh-loop-acceptance never writes. There is no --apply / --approve.');
    }
    else if (a === '--help' || a === '-h') out.help = true;
    else fail('Unknown argument: ' + a);
  }
  return out;
}

function cashBreakdown(plan) {
  return POSTED_CASH.map(id => {
    const row = (((plan || {}).startingCash || {}).breakdown || []).find(item => item && item.id === id);
    // A missing, null or non-numeric balance is unknown (null), never Number(null) === 0.
    const known = row && row.value != null && row.value !== '' && Number.isFinite(Number(row.value));
    return { id, value: known ? Number(row.value) : null };
  });
}

// Null when any spendable posted-cash row is missing or not a finite number:
// an unknown balance is unknown, never counted as 0.
function independentSpendable(plan) {
  let sum = 0;
  for (const row of cashBreakdown(plan)) {
    if (row.id === 'savings') continue;
    if (typeof row.value !== 'number' || !Number.isFinite(row.value)) return null;
    sum += row.value;
  }
  return sum;
}

function compactOverlays(overlay) {
  return ((overlay && overlay.overlays) || []).map(row => ({
    locator: row.locator,
    field: row.field,
    currentValue: row.currentValue,
    proposedValue: row.proposedValue,
    evidenceDate: row.evidenceDate,
  }));
}

function compactProposal(preview) {
  return {
    previewId: preview && preview.previewId || null,
    waiting: !!(preview && Array.isArray(preview.mechanicallyProvable)
      && preview.mechanicallyProvable.length > 0),
    count: preview && Array.isArray(preview.mechanicallyProvable)
      ? preview.mechanicallyProvable.length
      : 0,
    writesCanonicalState: false,
    canonicalWriteAuthorized: false,
    rows: ((preview && preview.mechanicallyProvable) || []).map(row => ({
      locator: row.locator,
      field: row.field,
      currentValue: row.currentValue,
      proposedValue: row.proposedValue,
      evidenceDate: row.evidenceDate,
    })),
  };
}

function compactModeled(receipt) {
  const occurrences = ((receipt && receipt.occurrences) || []).map(row => ({
    id: row.id,
    date: row.date,
    settlement: row.settlement,
    plannedAmount: row.plannedAmount,
  }));
  const counts = (receipt && receipt.counts) || {};
  return {
    trusted: receipt && receipt.trusted === true,
    failClosedKind: (receipt && receipt.failClosedKind) || null,
    represented: occurrences.filter(row => row.settlement === 'represented'),
    upcoming: occurrences.filter(row => row.settlement === 'upcoming'),
    unverified: occurrences.filter(row => row.settlement === 'unverified'),
    ambiguous: occurrences.filter(row => row.settlement === 'ambiguous'),
    counts: {
      represented: Number(counts.represented) || 0,
      upcoming: Number(counts.upcoming) || 0,
      unverified: Number(counts.unverified) || 0,
      ambiguous: Number(counts.ambiguous) || 0,
      unmatchedCashEvidence: Number(counts.unmatchedCashEvidence) || 0,
    },
  };
}

function looksSanitized(packet) {
  const blob = JSON.stringify(packet == null ? {} : packet);
  return O.identityProofLooksSanitized(packet)
    && C.identityProofLooksSanitized(packet)
    && !/"payee"\s*:/.test(blob)
    && !/"original_name"\s*:/.test(blob)
    && !/"providerAccountId"\s*:/.test(blob)
    && !/"providerTransactionId"\s*:/.test(blob)
    && !/Bearer\s+\S+/.test(blob)
    && !/LUNCHMONEY_ACCESS_TOKEN/.test(blob)
    && !/ATLAS_PROVIDER_ACCOUNT_MAP_JSON/.test(blob);
}

function loopOnce(opts) {
  const overlay = Live.fromObservation({
    data: opts.data,
    payload: opts.payload,
    accountMap: opts.accountMap,
    identity: opts.identity,
  });
  const report = overlay.report;
  const preview = C.buildPreview(report, { data: opts.data });
  const figures = Live.forecastFrom(overlay.data, { baseline: opts.data });
  const direct = Forecast.recommend(overlay.data.plan, figures.asOf, OA.recommendOpts(overlay.data, {
    mode: 'live-overlay',
    writesCanonicalState: false,
  }));
  return { overlay, report, preview, figures, direct };
}

function fromIncumbents(opts) {
  opts = opts || {};
  const data = opts.data;
  if (!data) fail('Closed-loop acceptance needs canonical data.');
  const first = loopOnce(opts);
  const second = loopOnce(opts);
  const overlayMeta = first.overlay.data && first.overlay.data.liveOverlay;
  const trust = first.overlay.data && first.overlay.data.refreshTrust;
  const operating = first.figures && first.figures.operatingAnswer;
  const spendable = independentSpendable(first.overlay.data.plan);
  const forecastCash = Forecast.startingCashAmount(first.overlay.data.plan);
  const replayEqual = JSON.stringify({
    digest: first.report.observationReceipt && first.report.observationReceipt.fingerprintDigest,
    recon: first.report.obligationReconciliationReceipt,
    previewId: first.preview.previewId,
    overlay: overlayMeta,
    trust,
    operating,
  }) === JSON.stringify({
    digest: second.report.observationReceipt && second.report.observationReceipt.fingerprintDigest,
    recon: second.report.obligationReconciliationReceipt,
    previewId: second.preview.previewId,
    overlay: second.overlay.data && second.overlay.data.liveOverlay,
    trust: second.overlay.data && second.overlay.data.refreshTrust,
    operating: second.figures && second.figures.operatingAnswer,
  });
  const packet = {
    schema: SCHEMA,
    source: 'incumbent-observation-reconciliation-preview-overlay-forecast',
    writesCanonicalState: false,
    canonicalWriteAuthorized: false,
    unattended: false,
    scheduled: false,
    providerWrite: false,
    cardCapacityIsCash: first.report.cardCapacityIsCash === 0 ? 0 : first.report.cardCapacityIsCash,
    liveEvidence: {
      fetchedAt: first.report.fetchedAt || (opts.payload && opts.payload.fetchedAt) || null,
      householdDate: first.report.observationReceipt && first.report.observationReceipt.householdDate || null,
      observationReady: !!(first.report.observationReceipt
        && first.report.observationReceipt.readyForReconciliation === true),
      overlayApplied: !!(overlayMeta && overlayMeta.applied === true),
      historicalOpeningAsOf: first.overlay.historicalOpeningAsOf || null,
      effectiveAsOf: first.overlay.effectiveAsOf || null,
      changed: compactOverlays(overlayMeta),
      overlayCount: compactOverlays(overlayMeta).length,
      refusedCount: ((overlayMeta && overlayMeta.refused) || []).length,
    },
    modeledItems: compactModeled(first.report.obligationReconciliationReceipt),
    ownerQuestion: (trust && trust.ownerQuestion) || null,
    canonicalProposal: compactProposal(first.preview),
    forecast: {
      asOf: first.figures.asOf,
      startingCash: forecastCash,
      independentSpendable: spendable == null ? null : Math.round(spendable * 100) / 100,
      cashBreakdown: cashBreakdown(first.overlay.data.plan),
      recommendMode: first.figures.mode,
      weekly: first.figures.weekly,
      operatingAnswer: operating,
      projectorCopiesForecast: !!(operating
        && operating.moneyAvailable
        && operating.currentSpendingPermission
        && operating.moneyAvailable.value === first.direct.paydayAllocation.available
        && operating.currentSpendingPermission.weekly === first.direct.weekly),
      fundingBorrowed: first.direct.funding && first.direct.funding.borrowed != null
        ? first.direct.funding.borrowed
        : 0,
      plannedDebtPermitted: first.direct.plannedDebt ? first.direct.plannedDebt.permitted === true : null,
    },
    operatingAnswerChanged: !!(operating && operating.change && operating.change.changed === true),
    freshness: {
      displayState: trust && trust.displayState || null,
      remainingClaim: trust && trust.remainingClaim || null,
      categoryRemainingClaim: trust && trust.categoryRemainingClaim || null,
      coverageLimits: ((trust && trust.coverageLimits) || []).map(row => ({
        id: row.id,
        text: row.text,
      })),
    },
    idempotency: {
      samePayloadReplay: replayEqual,
      previewIdEqual: first.preview.previewId === second.preview.previewId,
    },
  };
  if (!looksSanitized(packet)) fail('Closed-loop acceptance packet is not sanitized.');
  if (typeof forecastCash !== 'number' || !Number.isFinite(forecastCash)) {
    fail('Forecast starting cash is unknown: the opening breakdown is incomplete.');
  }
  if (spendable == null) fail('Independent spendable cash is unknown: a posted cash balance is missing.');
  if (Math.abs(spendable - forecastCash) > 0.005) {
    fail('Independent spendable cash does not match Forecast.startingCashAmount.');
  }
  if (packet.cardCapacityIsCash !== 0) fail('Credit capacity was treated as household cash.');
  if (packet.forecast.fundingBorrowed !== 0 && packet.forecast.fundingBorrowed != null) {
    fail('Live acceptance must not auto-borrow.');
  }
  if (packet.forecast.plannedDebtPermitted === true) {
    fail('Live acceptance must not permit planned borrowing.');
  }
  if (!packet.idempotency.samePayloadReplay) {
    fail('Replay of identical provider evidence was not a no-op.');
  }
  return packet;
}

async function loadPayload(args) {
  if (args.live) {
    return O.fetchLunchMoneyLive(
      await O.resolveLiveToken(),
      new Date().toISOString(),
      O.CURRENT_STATE_HISTORY_DAYS
    );
  }
  return loadJson(args.fixture);
}

function loadAccountMap(args, data) {
  try {
    if (args.map) {
      const mapDoc = loadJson(args.map);
      if (args.live) O.assertLiveMap(mapDoc, { data });
      return mapDoc;
    }
    if (args.live) return O.loadLiveAccountMap(process.env, data);
    return loadJson(O.resolveMapPath({ fixture: args.fixture }));
  } catch (err) {
    if (args.live && String(err && err.message) === 'live-account-map-missing') {
      fail(
        'Trusted live account map is missing. Use ATLAS_PROVIDER_ACCOUNT_MAP_JSON '
        + 'or the owner-observed gitignored local map keyed by providerAccountId. '
        + 'Display names cannot reconstruct it.'
      );
    }
    throw err;
  }
}

async function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      'Usage: node scripts/refresh-loop-acceptance.js --fixture <file>\n'
      + '       node scripts/refresh-loop-acceptance.js --live\n'
      + 'Read-only closed loop. Never writes data.json, positions, or snapshots.\n'
    );
    return 0;
  }
  if (args.live && args.fixture) fail('Use either --fixture or --live, not both.');
  if (!args.live && !args.fixture) fail('Pass --fixture <file> or --live.');
  const paths = {
    data: args.data,
    positions: DEFAULT_POSITIONS,
    periods: DEFAULT_PERIODS,
    snapshots: DEFAULT_SNAPSHOTS,
  };
  const before = hashTree(paths);
  const data = loadJson(args.data);
  const accountMap = loadAccountMap(args, data);
  const payload = await loadPayload(args);
  const packet = fromIncumbents({
    data,
    payload,
    accountMap,
    identity: loadIdentity(DEFAULT_IDENTITY),
  });
  const after = hashTree(paths);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    fail('Closed-loop acceptance mutated canonical files.');
  }
  packet.canonicalUnchanged = true;
  if (!looksSanitized(packet)) fail('Closed-loop acceptance packet is not sanitized.');
  process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
  return 0;
}

const api = {
  SCHEMA,
  POSTED_CASH,
  parseArgs,
  hashTree,
  independentSpendable,
  looksSanitized,
  fromIncumbents,
  run,
};

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => {
    process.exit(code);
  }).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
} else {
  module.exports = api;
}
