'use strict';
/* AF-REFRESH-06 — household-facing refresh trust on the operating surface.
 *
 * Independent of scripts/refresh-trust.js for remaining-claim: the same
 * served plan/asOf/actuals go directly to Forecast.recommend. The projector
 * must copy that remainingClaim. Synthetic HTML cases are constructed from
 * incumbent closed vocabularies, not from the projector's own displayState
 * helper. Live data.json cents are not the specification (L-006). Canonical
 * files are hashed for no-write.
 */
const { loadBudgetPage } = require('./lib/budget-page-harness');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Live = require('../scripts/live-plan.js');
const RT = require('../scripts/refresh-trust.js');
const OA = require('../scripts/operating-answer.js');
const Forecast = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data.json');
const POSITIONS = path.join(ROOT, 'docs', 'positions.csv');
const PERIODS = path.join(ROOT, 'public', 'periods.json');
const SNAPSHOTS = path.join(ROOT, 'snapshots');
const SENTINEL_USED = 4567.89;
const SENTINEL_REMAINING = 9876.54;

let failures = 0;
function ok(cond, label, detail) {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}
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
function read(file) {
  return sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

const liveData = load(DATA);
const periods = fs.existsSync(PERIODS) ? load(PERIODS) : null;
const beforeTree = hashTree();

function filesUnchanged(label) {
  const now = hashTree();
  ok(now.data === beforeTree.data, `${label}: data.json bytes unchanged`);
  ok(now.positions === beforeTree.positions, `${label}: positions.csv unchanged`);
  ok(now.periods === beforeTree.periods, `${label}: periods.json unchanged`);
  ok(now.snapshots === beforeTree.snapshots, `${label}: snapshots unchanged`);
}

function directRecommend(data) {
  const plan = data.plan;
  const asOf = OA.asOfFrom(data, { mode: 'live-overlay' });
  return Forecast.recommend(plan, asOf, {
    fundingSources: plan.funding && plan.funding.options,
    debts: data.debts,
    revolvingExtra: data.revolvingExtra,
    periods,
    currentPeriodActuals: OA.actualsFrom(data, { mode: 'live-overlay' }),
  });
}

function preciseActuals(asOf) {
  return {
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: asOf,
    coverageStart: '2026-08-01',
    coverageThrough: asOf,
    pendingCoverage: 'complete',
    transactionCoverage: 'complete',
    transactions: [],
  };
}

function withOverlayActuals(actuals, extraOverlay) {
  const data = clone(liveData);
  const asOf = data.meta.asOf;
  data.liveOverlay = Object.assign({
    schema: 'atlas-live-plan-overlay/v1',
    applied: true,
    writesCanonicalState: false,
    productionWrite: false,
    unattended: false,
    historicalOpeningAsOf: asOf,
    effectiveAsOf: asOf,
    observedAsOf: asOf,
    representedEvents: [],
    overlays: [],
    refused: [],
    currentPeriodActuals: actuals,
  }, extraOverlay || {});
  return data;
}

function loadComposer() {
  // The real Budget page (test/lib/budget-page-harness.js). operatingSurfaceHtml
  // is the live composition: the Today card plus the compact pay-period content.
  const page = loadBudgetPage({ Forecast: Forecast, state: { scenario: null, targetBuffer: 500, extraDebtMonthly: 0, incomeOverrides: {}, disabled: [], debts: null, extraDebtTarget: null, extraFacilities: null } });
  return { operatingSurfaceHtml: ctx => page.surfaceHtml(ctx),
    refreshTrustHtml: page.get('refreshTrustHtml'), weeklyCapView: page.get('weeklyCapView'), paydayCoverageNote: page.get('paydayCoverageNote'), money2: page.get('money2') };
}

function money2(n) {
  return Number(n).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' });
}

function actionFrom(extra) {
  return Object.assign({
    mode: 'between-paydays',
    asOf: '2026-09-08',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-14',
    nextPayday: '2026-09-15',
    coverage: {
      status: 'current', remainingClaim: 'precise', pendingStatus: 'complete',
      coverageStart: '2026-09-01', coverageThrough: '2026-09-08', reason: null,
    },
    bills: [], categories: [],
    unclassified: { posted: 0, pending: 0, count: 0 },
    weeklyCap: 321.45,
    spendPermission: 642.90,
    currentShortfall: false,
    todayActions: [], noMovementToday: true,
    remainingClaim: 'precise',
    categoryRemainingClaim: 'precise',
  }, extra || {});
}

function sentinelCategory() {
  return {
    id: 'sentinel', label: 'Sentinel category', class: 'essential',
    committed: SENTINEL_USED, remaining: SENTINEL_REMAINING,
  };
}

function trustPacket(extra) {
  return Object.assign({
    schema: RT.SCHEMA,
    source: 'incumbent-observation-reconciliation-forecast',
    writesCanonicalState: false,
    displayState: 'current',
    observedAsOf: '2026-09-08',
    reconciledAsOf: '2026-09-08',
    remainingClaim: 'precise',
    categoryRemainingClaim: 'precise',
    exactFiguresAvailable: true,
    coverageLimits: [],
    unresolvedMaterial: [],
    canonicalProposalWaiting: false,
    canonicalProposalCount: 0,
    ownerQuestion: null,
    observationReady: true,
    overlayApplied: true,
    refreshPath: 'on-demand-reload',
  }, extra || {});
}

const composer = loadComposer();
const cap = { hasFeasibleCap: true, infeasible: false, reason: '' };

console.log('=== A. overlay-off remainingClaim is Forecast, not invented ===');
{
  const served = Live.serveCanonicalOrFixture(liveData, {});
  const advice = directRecommend(served);
  ok(served !== liveData, 'overlay-off serve clones rather than mutating the cached opening');
  ok(!served.liveOverlay, 'overlay-off does not invent liveOverlay metadata');
  ok(served.refreshTrust && served.refreshTrust.schema === RT.SCHEMA,
    'overlay-off still attaches a household refresh-trust packet');
  ok(served.refreshTrust.remainingClaim === advice.currentPeriodAction.remainingClaim,
    'packet remainingClaim copies Forecast.recommend',
    `${served.refreshTrust.remainingClaim} vs ${advice.currentPeriodAction.remainingClaim}`);
  ok(served.refreshTrust.exactFiguresAvailable
    === (advice.currentPeriodAction.remainingClaim !== 'unavailable'),
    'exactFiguresAvailable follows the incumbent remainingClaim');
  ok(served.refreshTrust.displayState === RT.DISPLAY_ATTENTION,
    'dated opening without actuals is attention-needed, not current');
  ok(served.refreshTrust.refreshPath === 'dated-opening',
    'overlay-off names the dated-opening refresh path');
  ok(served.refreshTrust.canonicalProposalWaiting === false
    && !served.refreshTrust.ownerQuestion,
    'dated opening invents neither a waiting proposal nor an owner question');
  ok(served.refreshTrust.observedAsOf == null,
    'overlay-off does not publish the canonical opening as last-observed');
  const overlayOffHtml = composer.refreshTrustHtml(served.refreshTrust);
  ok(/When this was last updated is unknown/.test(overlayOffHtml)
    && !/last saved picture of the accounts/.test(overlayOffHtml)
    && !/Last observed/.test(overlayOffHtml),
  'overlay-off HTML says when this was last updated is unknown, not Last observed');
  ok(RT.looksSanitized(served.refreshTrust), 'overlay-off packet is sanitized');
  filesUnchanged('overlay-off');
}

console.log('\n=== B. current actuals copy Forecast remainingClaim ===');
{
  const data = withOverlayActuals(preciseActuals(liveData.meta.asOf));
  const advice = directRecommend(data);
  const packet = RT.fromIncumbent({ data, canonical: liveData });
  ok(advice.currentPeriodAction.remainingClaim === 'precise',
    'independent Forecast remainingClaim is precise on complete current actuals');
  ok(packet.remainingClaim === 'precise',
    'projector copies that precise remainingClaim');
  ok(packet.displayState === RT.DISPLAY_CURRENT,
    'complete applied overlay with precise remaining is current');
  ok(packet.exactFiguresAvailable === true, 'current packet allows exact remaining');
  ok(packet.observedAsOf === liveData.meta.asOf, 'observed as-of is the overlay observation date');
  ok(packet.canonicalProposalWaiting === false, 'no proposal is invented without a preview');
}

console.log('\n=== C. stale and incomplete actuals cannot look current ===');
{
  const asOf = liveData.meta.asOf;
  const staleData = withOverlayActuals({
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: '2026-08-09',
    coverageStart: '2026-08-01',
    coverageThrough: '2026-08-09',
    pendingCoverage: 'complete',
    transactionCoverage: 'complete',
    transactions: [],
  });
  const staleAdvice = directRecommend(staleData);
  const stalePacket = RT.fromIncumbent({ data: staleData, canonical: liveData });
  ok(staleAdvice.currentPeriodAction.remainingClaim === 'unavailable'
    && staleAdvice.currentPeriodAction.coverage.status === 'stale',
    'independent Forecast marks stale actuals unavailable');
  ok(stalePacket.remainingClaim === 'unavailable'
    && stalePacket.displayState === RT.DISPLAY_ATTENTION
    && stalePacket.exactFiguresAvailable === false,
    'stale projector state is attention-needed and withholds exact figures');

  const incompleteData = withOverlayActuals({
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: asOf,
    coverageStart: asOf,
    coverageThrough: asOf,
    pendingCoverage: 'complete',
    transactionCoverage: 'truncated',
    transactions: [],
  });
  const incompleteAdvice = directRecommend(incompleteData);
  const incompletePacket = RT.fromIncumbent({ data: incompleteData, canonical: liveData });
  ok(incompleteAdvice.currentPeriodAction.remainingClaim === 'unavailable'
    && incompleteAdvice.currentPeriodAction.coverage.status === 'incomplete',
    'independent Forecast marks truncated coverage incomplete');
  ok(incompletePacket.remainingClaim === 'unavailable'
    && incompletePacket.displayState === RT.DISPLAY_ATTENTION
    && incompletePacket.exactFiguresAvailable === false,
    'incomplete projector state is attention-needed and withholds exact figures');
}

console.log('\n=== D. ambiguous evidence is attention-needed and not settled ===');
{
  const data = withOverlayActuals(preciseActuals(liveData.meta.asOf));
  const report = {
    observationReceipt: {
      schema: 'atlas-observation-receipt/v1',
      householdDate: liveData.meta.asOf,
      observedAt: '2026-08-19T18:00:00.000Z',
      readyForReconciliation: true,
      failClosedReasons: [],
      pendingTransactionCoverage: { complete: true, status: 'complete' },
    },
    obligationReconciliationReceipt: {
      schema: 'atlas-obligation-reconciliation-receipt/v1',
      trusted: true,
      asOf: liveData.meta.asOf,
      householdDate: liveData.meta.asOf,
      counts: {
        coveredModeledOccurrences: 1, represented: 0, upcoming: 0,
        unverified: 0, ambiguous: 1, outsideCoverage: 0, unmatchedCashEvidence: 0,
      },
      occurrences: [{
        id: 'uniondues-aug15-outstanding',
        date: '2026-08-16',
        settlement: 'ambiguous',
      }],
      unmatchedCashEvidence: [],
    },
  };
  const packet = RT.fromIncumbent({
    data,
    canonical: liveData,
    report,
    preview: {
      mechanicallyProvable: [],
      unresolved: [{
        id: 'uniondues-aug15-outstanding',
        date: '2026-08-16',
        reason: 'ambiguous-evidence-must-not-write',
      }],
      ownerQuestions: [],
    },
  });
  ok(packet.displayState === RT.DISPLAY_ATTENTION,
    'ambiguous evidence is attention-needed even when remaining is precise');
  ok(packet.unresolvedMaterial.some(row => row.kind === 'ambiguous-evidence-must-not-write'),
    'ambiguous evidence is listed as unresolved, not settled');
  ok(packet.canonicalProposalWaiting === false,
    'ambiguous evidence does not create a waiting canonical proposal');
  ok(!JSON.stringify(packet).includes('payee'),
    'ambiguous packet still has no raw payee');
}

console.log('\n=== E. posted-only is partially current, not exact ===');
{
  const data = withOverlayActuals({
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: liveData.meta.asOf,
    coverageStart: '2026-08-01',
    coverageThrough: liveData.meta.asOf,
    pendingCoverage: 'partial',
    transactionCoverage: 'complete',
    transactions: [],
  });
  const advice = directRecommend(data);
  const packet = RT.fromIncumbent({ data, canonical: liveData });
  ok(advice.currentPeriodAction.remainingClaim === 'posted-only',
    'independent Forecast remainingClaim is posted-only when pending is partial');
  ok(packet.remainingClaim === 'posted-only'
    && packet.displayState === RT.DISPLAY_PARTIAL
    && packet.exactFiguresAvailable === true,
    'posted-only is partially current and still observed, not unavailable');
}

console.log('\n=== F. HTML current / stale / incomplete / ambiguous render distinctly ===');
{
  const currentHtml = composer.operatingSurfaceHtml({
    advice: {
      weekly: 180,
      paydayAllocation: { available: 100, risks: [], unresolved: [], extraDebt: { allocated: 0 } },
      currentPeriodAction: actionFrom({ categories: [sentinelCategory()] }),
    },
    refreshTrust: trustPacket(),
    capView: cap,
  });
  ok(!/data-refresh-trust-state=/.test(currentHtml)
      && !/Notes behind these numbers/.test(currentHtml)
      && !/data-refresh-attention/.test(currentHtml)
      && !/data-operating-warnings/.test(currentHtml),
    'usable current Plan does not render the large Current status card or an attention warning');
  ok(currentHtml.includes(composer.money2(100)),
    'usable current Plan still publishes the Forecast available-cash figure');
  ok(!/waiting for approval/.test(currentHtml)
    && !/data-refresh-trust-owner-question/.test(currentHtml)
    && !/<dialog/.test(currentHtml)
    && !/Approve/.test(currentHtml),
  'current packet has no approval ceremony and no invented owner question');

  const staleAction = actionFrom({
    coverage: {
      status: 'stale', remainingClaim: 'unavailable', pendingStatus: 'unknown',
      coverageStart: null, coverageThrough: '2026-08-09',
      reason: 'Transaction actuals are not current through the financial as-of.',
    },
    remainingClaim: 'unavailable',
    categoryRemainingClaim: 'unavailable',
    categories: [sentinelCategory()],
  });
  const staleHtml = composer.operatingSurfaceHtml({
    advice: {
      weekly: 180,
      paydayAllocation: { available: 100, risks: [], unresolved: [], extraDebt: { allocated: 0 } },
      currentPeriodAction: staleAction,
    },
    refreshTrust: trustPacket({
      displayState: 'attention-needed',
      exactFiguresAvailable: false,
      remainingClaim: 'unavailable',
      observedAsOf: '2026-08-09',
      reconciledAsOf: null,
      coverageLimits: [{
        id: 'forecast-stale',
        text: 'Transaction actuals are not current through the financial as-of.',
      }],
    }),
    capView: cap,
  });
  ok(!/data-refresh-trust-state=/.test(staleHtml)
      && !/Attention needed/.test(staleHtml)
      && !/Notes behind these numbers/.test(staleHtml)
      && !/data-refresh-attention/.test(staleHtml),
    'usable Plan does not render the large Attention needed card');
  ok(!staleHtml.includes(composer.money2(SENTINEL_USED))
    && !staleHtml.includes(composer.money2(SENTINEL_REMAINING)),
  'stale remaining cents are not presented as a precise answer');
  const staleCoverage = composer.paydayCoverageNote(staleAction);
  ok(/Current remaining spend cannot be confirmed|current remaining amounts unavailable/.test(staleCoverage),
    'paydayCoverageNote still describes stale remaining-spend');
  ok(!/Current remaining spend cannot be confirmed|current remaining amounts unavailable/.test(staleHtml)
      && !/data-operating-warnings/.test(staleHtml),
    'stale remaining-spend copy is not printed as an advisory on the usable Plan');

  const incompleteHtml = composer.refreshTrustHtml(trustPacket({
    displayState: 'attention-needed',
    exactFiguresAvailable: false,
    remainingClaim: 'unavailable',
    coverageLimits: [{
      id: 'posted-window-truncated',
      text: 'Posted transaction coverage is truncated, so remaining spend cannot be confirmed as complete.',
    }],
  }));
  ok(/data-refresh-trust-state="attention-needed"/.test(incompleteHtml)
    && /truncated/.test(incompleteHtml)
    && incompleteHtml !== currentHtml,
  'incomplete coverage renders a distinct attention-needed strip');

  const ambiguousHtml = composer.refreshTrustHtml(trustPacket({
    displayState: 'attention-needed',
    unresolvedMaterial: [{
      kind: 'ambiguous-evidence-must-not-write',
      text: 'A modeled item has more than one matching observation and was not treated as settled.',
    }],
  }));
  ok(/data-refresh-trust-state="attention-needed"/.test(ambiguousHtml)
    && /more than one matching observation/.test(ambiguousHtml)
    && !/waiting for approval/.test(ambiguousHtml)
    && !/treated as settled\.</.test(ambiguousHtml.replace(/not treated as settled/, '')),
  'ambiguous HTML stays unresolved and does not open an approval ceremony');

  const AMBIGUOUS_COPY = 'A modeled item has more than one matching observation and was not treated as settled.';
  const ambiguousPlanHtml = composer.operatingSurfaceHtml({
    advice: {
      weekly: 180,
      paydayAllocation: { available: 100, risks: [], unresolved: [], extraDebt: { allocated: 0 } },
      currentPeriodAction: actionFrom({ categories: [sentinelCategory()] }),
    },
    refreshTrust: trustPacket({
      displayState: 'attention-needed',
      unresolvedMaterial: [{
        kind: 'ambiguous-evidence-must-not-write',
        text: AMBIGUOUS_COPY,
      }],
    }),
    capView: cap,
  });
  ok(!/data-operating-warnings/.test(ambiguousPlanHtml)
      && !/data-refresh-attention/.test(ambiguousPlanHtml)
      && !ambiguousPlanHtml.includes(AMBIGUOUS_COPY)
      && !/data-refresh-trust-state=/.test(ambiguousPlanHtml)
      && !/Notes behind these numbers/.test(ambiguousPlanHtml)
      && !/waiting for approval/.test(ambiguousPlanHtml),
    'attention-needed with exact remaining does not print compact unresolved copy on the usable Plan');
  ok(ambiguousPlanHtml.includes(composer.money2(100)),
    'attention-needed with exact remaining still publishes Forecast available cash');
  ok(/data-refresh-trust-state="attention-needed"/.test(composer.refreshTrustHtml(trustPacket({
    displayState: 'attention-needed',
    unresolvedMaterial: [{
      kind: 'ambiguous-evidence-must-not-write',
      text: AMBIGUOUS_COPY,
    }],
  }))) && composer.refreshTrustHtml(trustPacket({
    displayState: 'attention-needed',
    unresolvedMaterial: [{
      kind: 'ambiguous-evidence-must-not-write',
      text: AMBIGUOUS_COPY,
    }],
  })).includes(AMBIGUOUS_COPY),
    'refreshTrustHtml still preserves the unresolved copy for the unavailable surface');

  const emptyAttentionHtml = composer.operatingSurfaceHtml({
    advice: {
      weekly: 180,
      paydayAllocation: { available: 100, risks: [], unresolved: [], extraDebt: { allocated: 0 } },
      currentPeriodAction: actionFrom({ categories: [sentinelCategory()] }),
    },
    refreshTrust: trustPacket({ displayState: 'attention-needed' }),
    capView: cap,
  });
  ok(!/data-refresh-attention/.test(emptyAttentionHtml)
      && !/>Attention needed</.test(emptyAttentionHtml)
      && !/data-operating-warnings/.test(emptyAttentionHtml)
      && !/data-refresh-trust-state=/.test(emptyAttentionHtml),
    'attention-needed with exact remaining and no extras prints no compact Attention needed line on the usable Plan');
  ok(/>Attention needed</.test(composer.refreshTrustHtml(trustPacket({ displayState: 'attention-needed' }))),
    'refreshTrustHtml still preserves the Attention needed label for the unavailable surface');

  const ownerQuestionCopy = 'Atlas still needs a household fact before treating this modeled item as settled.';
  const askedPlanHtml = composer.operatingSurfaceHtml({
    advice: {
      weekly: 180,
      paydayAllocation: { available: 100, risks: [], unresolved: [], extraDebt: { allocated: 0 } },
      currentPeriodAction: actionFrom({ categories: [sentinelCategory()] }),
    },
    refreshTrust: trustPacket({
      displayState: 'attention-needed',
      ownerQuestion: {
        id: 'uniondues-aug15-outstanding',
        date: '2026-08-16',
        text: ownerQuestionCopy,
      },
    }),
    capView: cap,
  });
  ok(!/data-refresh-attention/.test(askedPlanHtml)
      && !askedPlanHtml.includes(ownerQuestionCopy)
      && !/data-operating-warnings/.test(askedPlanHtml)
      && !/data-refresh-trust-state=/.test(askedPlanHtml),
    'attention-needed owner question is not printed as compact warning copy on the usable Plan');
  ok(composer.refreshTrustHtml(trustPacket({
    displayState: 'attention-needed',
    ownerQuestion: {
      id: 'uniondues-aug15-outstanding',
      date: '2026-08-16',
      text: ownerQuestionCopy,
    },
  })).includes(ownerQuestionCopy),
    'refreshTrustHtml still preserves the owner-question copy for the unavailable surface');
}

console.log('\n=== G. proposal and owner question appear only when incumbent supplied them ===');
{
  const none = composer.refreshTrustHtml(trustPacket());
  ok(!/waiting for approval/.test(none)
    && !/data-refresh-trust-owner-question/.test(none)
    && !/<button/.test(none),
  'nothing to approve means no approval UI');

  const waiting = composer.refreshTrustHtml(trustPacket({
    canonicalProposalWaiting: true,
    canonicalProposalCount: 1,
  }));
  ok(/data-refresh-trust-proposal/.test(waiting)
    && /waiting for approval/.test(waiting)
    && !/<dialog/.test(waiting)
    && !/<form/.test(waiting),
  'a waiting proposal is named without a modal approval ceremony');

  const asked = composer.refreshTrustHtml(trustPacket({
    ownerQuestion: {
      id: 'uniondues-aug15-outstanding',
      date: '2026-08-16',
      text: 'Atlas still needs a household fact before treating this modeled item as settled. CMAW Local 1995 union dues — 15 August posting unknown.',
    },
  }));
  ok(/data-refresh-trust-owner-question/.test(asked)
    && /household fact/.test(asked)
    && /union dues/.test(asked),
  'the smallest incumbent owner question is shown when one exists');
}

console.log('\n=== H. live failure before an observation receipt does not fabricate Last observed ===');
{
  const failed = Live.failedOverlay(liveData, 'provider-unavailable');
  ok(failed.liveOverlay && failed.liveOverlay.applied === false,
    'failure-before-receipt keeps overlay unapplied');
  ok(failed.refreshTrust && failed.refreshTrust.observedAsOf == null,
    'failure-before-receipt does not copy the canonical opening into observedAsOf');
  ok(failed.refreshTrust.displayState === RT.DISPLAY_ATTENTION,
    'failure-before-receipt stays attention-needed');
  const html = composer.refreshTrustHtml(failed.refreshTrust);
  ok(/When this was last updated is unknown/.test(html)
    && !/Last observed/.test(html),
  'failure-before-receipt HTML does not render a fabricated Last observed date');
  filesUnchanged('failure-before-receipt');
}

console.log('\n=== I. projector and page do not invent settlement or leak provider details ===');
{
  const src = read('scripts/refresh-trust.js');
  ok(!/function canonicalAsOf/.test(src)
    && !/observedAsOf[\s\S]{0,80}plan\.opening/.test(src),
    'projector has no canonical-opening fallback for last-observed');
  ok(!/Forecast\.recommend/.test(src) || /OA\.fromRefreshedState/.test(src),
    'refresh-trust.js does not reimplement Forecast remaining-claim arithmetic');
  ok(!/displayState = 'current'/.test(src.replace(/DISPLAY_CURRENT = 'current'/, '')),
    'current is not hard-coded as a default household claim');
  const planSrc = read('public/plan.js');
  const fn = /function refreshTrustHtml\([\s\S]*?\n\}/.exec(planSrc);
  ok(fn && !/\bForecast\.[A-Za-z]+\s*\(/.test(fn[0]),
    'refreshTrustHtml calls no Forecast function');
  ok(fn && !/\.reduce\(|remainingClaim ===/.test(fn[0]),
    'refreshTrustHtml does not compute remaining-claim or totals');
  const packet = RT.fromIncumbent({ data: clone(liveData) });
  const blob = JSON.stringify(packet);
  ok(!/"payee"/.test(blob) && !/"providerAccountId"/.test(blob)
    && !/"providerTransactionId"/.test(blob) && !/"proposedValue"/.test(blob),
  'household packet has no raw provider or proposed-value details');
}

console.log('\n=== J. homepage still leads with the operating surface ===');
{
  const html = read('public/index.html');
  ok(/id="operating-surface"/.test(html)
    && html.indexOf('id="operating-surface"') < html.indexOf('id="payday-answer"'),
  'the decision-first operating surface remains first');
  ok(!/Live Current Balance, then this payday/.test(html)
    && !/<h1>This payday<\/h1>/.test(html)
    && !/View full current-period worksheet/.test(html)
    && !/Why \/ Road ahead/.test(html),
    'the Budget page does not restore the This payday header, worksheet, or Why / Road ahead');
}

filesUnchanged('suite close');

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nAll AF-REFRESH-06 refresh-trust proofs passed.');
