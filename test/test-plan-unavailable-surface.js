'use strict';
/* Page-level unavailable operating state. When liveOverlay.operatingPlan is
 * unavailable, the Plan surface must fail closed at the page, not by
 * repeating the dated waterfall with eleven unavailable cards.
 *
 * Uses the incumbent dated opening on this main (data.json) plus the same
 * fail-closed overlay fixture path as test-live-plan.js. Independent cash:
 * the startingCash breakdown sum still includes designated savings as
 * reserve evidence (L-002); Forecast dated currentBalance / printed last
 * trusted opening is household chequing only. Live overlay cents are not
 * the specification (L-006). Forecast remains the calculation authority.
 *
 * `node test/test-plan-unavailable-surface.js`
 */
const { loadBudgetPage } = require('./lib/budget-page-harness');
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));

function loadComposer() {
  // The real Budget page (test/lib/budget-page-harness.js). operatingSurfaceHtml
  // is the live composition: the Today card plus the compact pay-period content.
  const page = loadBudgetPage({ Forecast: F, state: { scenario: null, targetBuffer: 500, extraDebtMonthly: 0, incomeOverrides: {}, disabled: [], debts: null, extraDebtTarget: null, extraFacilities: null } });
  return { operatingSurfaceHtml: ctx => page.surfaceHtml(ctx),
    unavailableOperatingSurfaceHtml: page.get('unavailableOperatingSurfaceHtml'), refreshTrustHtml: page.get('refreshTrustHtml'), applyUnavailableOperatingChrome: page.get('applyUnavailableOperatingChrome'), money2: page.get('money2'), fmtDateLong: page.get('fmtDateLong') };
}

function independentDatedCash(plan) {
  const rows = (plan && plan.startingCash && plan.startingCash.breakdown) || [];
  return Math.round(rows.reduce((s, r) => s + (Number(r && r.value) || 0), 0) * 100) / 100;
}

function independentChequing(plan) {
  const rows = (plan && plan.startingCash && plan.startingCash.breakdown) || [];
  return Math.round(rows.reduce((s, r) => {
    if (!r || (r.id !== 'chequing-a' && r.id !== 'chequing-b')) return s;
    return s + (Number(r.value) || 0);
  }, 0) * 100) / 100;
}

function independentHub(plan) {
  const rows = ((plan && plan.startingCash && plan.startingCash.breakdown) || [])
    .filter(r => r && r.id === 'chequing-a');
  if (rows.length !== 1) return null;
  const value = Number(rows[0].value);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function independentBell(plan) {
  return ((plan && plan.bills) || []).find(row => row && row.id === 'bell') || null;
}

function count(html, re) {
  return (String(html || '').match(re) || []).length;
}

function chromeDoc() {
  const store = {
    kicker: { textContent: 'This payday' },
    heading: { textContent: 'This payday' },
    lede: { textContent: 'Current Balance, bills this pay period, household budget, the card to pay extra toward, other cards, and big purchases — each with leftover after that step.' },
    summary: { textContent: 'View full current-period worksheet' },
  };
  const surface = {
    querySelector(sel) {
      if (sel === '.kicker') return store.kicker;
      if (sel === 'h1') return store.heading;
      if (sel === '.lede') return store.lede;
      return null;
    },
  };
  const payday = {
    querySelector(sel) {
      if (sel === 'summary') return store.summary;
      return null;
    },
  };
  return {
    store,
    getElementById(id) {
      if (id === 'operating-surface') return surface;
      if (id === 'payday-answer') return payday;
      return null;
    },
  };
}

const liveData = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const composer = loadComposer();
const OPENING = String(liveData.plan.opening.asOf);
const DATED_CASH = independentDatedCash(liveData.plan);
const CHEQUING_CASH = independentChequing(liveData.plan);
const HUB_CASH = independentHub(liveData.plan);
const BELL = independentBell(liveData.plan);
const NOTE = 'Current plan unavailable. The dated opening is stale.';

console.log('=== 1. incumbent dated opening is still Aug 19 / $939.62 ===');
{
  ok(OPENING === '2026-08-19',
    'canonical opening on this main is still 2026-08-19');
  ok(near(DATED_CASH, 939.62),
    'independent startingCash breakdown still sums to $939.62',
    String(DATED_CASH));
  ok(near(CHEQUING_CASH, 939.04) && !near(CHEQUING_CASH, DATED_CASH),
    'independent household chequing is $939.04; designated savings stays on the breakdown',
    String(CHEQUING_CASH));
  ok(BELL && near(Number(BELL.amount), 160) && BELL.day === 15 && BELL.needsDate !== true
      && BELL.firstDue === '2026-10-15',
    'independent Bell row is standing $160, dated on the 15th from October');
}

console.log('\n=== 2. Forecast unavailable walk keeps the dated opening ===');
{
  const advice = F.recommend(liveData.plan, OPENING, {
    debts: liveData.debts,
    revolvingExtra: liveData.revolvingExtra,
    targetBuffer: liveData.plan.defaults.targetBuffer,
    operatingPlan: 'unavailable',
    operatingPlanNote: NOTE,
  });
  ok(advice.operatingPlanUnavailable === true && advice.defaultView.asOf === OPENING,
    'Forecast keeps the dated opening as-of; it does not invent a later as-of');
  ok(near(Number(advice.defaultView.currentBalance), CHEQUING_CASH),
    'Forecast dated currentBalance is the independent chequing opening');
  ok(!(advice.defaultView.undatedBills || []).some(row => row && row.id === 'bell'),
    'Forecast no longer publishes Bell as an undated needsDate row');
}

console.log('\n=== 3. real Plan rendering path: compact unavailable state ===');
{
  const OBSERVED = '2026-08-31';
  const liveOverlay = {
    applied: false,
    operatingPlan: 'unavailable',
    operatingPlanNote: NOTE,
    historicalOpeningAsOf: OPENING,
    observedAsOf: OBSERVED,
  };
  const refreshTrust = {
    displayState: 'attention-needed',
    overlayApplied: false,
    observedAsOf: OBSERVED,
    reconciledAsOf: null,
    exactFiguresAvailable: false,
    remainingClaim: 'unavailable',
    coverageLimits: [],
    unresolvedMaterial: [],
    canonicalProposalWaiting: false,
    refreshPath: 'on-demand-reload',
  };
  const advice = F.recommend(liveData.plan, OPENING, {
    debts: liveData.debts,
    revolvingExtra: liveData.revolvingExtra,
    targetBuffer: liveData.plan.defaults.targetBuffer,
    operatingPlan: liveOverlay.operatingPlan,
    operatingPlanNote: liveOverlay.operatingPlanNote,
  });
  const html = composer.operatingSurfaceHtml({
    advice,
    weekly: advice.weekly,
    recommended: advice.weekly,
    liveOverlay,
    refreshTrust,
    asOf: OPENING,
  });

  ok(advice.defaultView.asOf === OPENING && near(Number(advice.defaultView.currentBalance), CHEQUING_CASH),
    'unavailable Forecast result retains the exact dated opening/as-of');
  ok(/data-unavailable-primary/.test(html)
      && /data-current-operating="unavailable"/.test(html)
      && /data-operating-plan="unavailable"/.test(html),
    'page contains one clear current-plan-unavailable primary state');
  ok(count(html, /<p class="operating-lead">Current plan unavailable<\/p>/g) === 1,
    'primary unavailable heading is emitted once');
  // Live Budget: the unavailable primary states it once; the separate Bills
  // closing card below restates it only as its own reason (closing reason
  // and its detail), never once per row.
  const closingAt = html.indexOf('data-bills-closing');
  const primary = closingAt > 0 ? html.slice(0, closingAt) : html;
  ok(count(primary, /The dated opening is stale/g) === 1
      && count(html, /The dated opening is stale/g) <= 3,
    'stale-opening note is not repeated eleven times',
    String(count(html, /The dated opening is stale/g)));
  ok(!/>Current Balance</i.test(html) && !/Current Balance/i.test(html),
    'dated cash is not labelled Current Balance');
  ok(/data-last-trusted-opening/.test(html)
      && /Last trusted opening/.test(html)
      && /Dated balance — not current/.test(html)
      && html.includes(composer.money2(CHEQUING_CASH))
      && /August 19/.test(html),
    'dated cash is explicitly dated/non-current and keeps the independent chequing opening / Aug 19');
  ok(!/data-calendar-waterfall/.test(html)
      && !/data-calendar-period-picker/.test(html)
      && !/>This payday</.test(html)
      && !/Pay periods this month/.test(html)
      && !/>Pay periods</.test(html),
    'normal active pay-period waterfall does not render as current');
  ok(!/data-operating-question=/.test(html)
      && !/data-operating-prompt="Income"/.test(html)
      && !/data-operating-prompt="Balance after payday"/.test(html)
      && !/data-operating-prompt="Bills"/.test(html)
      && !/data-operating-prompt="Household budget"/.test(html)
      && !/data-operating-prompt="Extra credit-card repayment"/.test(html)
      && !/data-operating-prompt="Big-purchase savings"/.test(html)
      && !/data-operating-prompt="Projected ending balance"/.test(html),
    'current Income / Available / Bills / Household Budget / extra-debt / big-purchase / projected-ending cards are withheld');
  ok(!/View full current-period worksheet/.test(html)
      && /View dated August 19 plan/.test(html)
      && /not today's operating plan/.test(html),
    'dated-plan access is historical, not a current trusted worksheet');
  ok(!/Updated August 31/.test(html)
      && !/Updated Aug 31/.test(html)
      && /Later refresh observed August 31 was not applied/.test(html),
    'refresh/observation timestamp cannot be mistaken for financial as-of');
  // Live Budget: the Bills closing card has its own "What needs
  // confirmation" heading; no Bell row survives on the unavailable surface.
  ok(!/data-period-bill="bell"/.test(html) && !/Bell[^<]{0,80}needs confirmation/.test(html),
    'unavailable surface does not keep a stale Bell needs-confirmation row');
  ok(html.includes(composer.money2(CHEQUING_CASH))
      && !html.includes(composer.money2(DATED_CASH))
      && !html.includes('August 31 opening')
      && advice.defaultView.asOf === '2026-08-19',
    'no later as-of is invented on the rendered page');
}

console.log('\n=== 4. heading chrome distinguishes dated plan from current payday ===');
{
  const doc = chromeDoc();
  composer.applyUnavailableOperatingChrome(true, OPENING, {
    applied: false,
    historicalOpeningAsOf: OPENING,
    operatingPlan: 'unavailable',
    operatingPlanNote: NOTE,
  }, doc);
  ok(doc.store.heading.textContent === 'Current plan unavailable'
      && doc.store.kicker.textContent === 'Current plan unavailable',
    'page heading is Current plan unavailable, not This payday');
  ok(/Last trusted financial opening is August 19/.test(doc.store.lede.textContent)
      && /later live refresh could not safely advance/.test(doc.store.lede.textContent)
      && !/Current Balance/.test(doc.store.lede.textContent),
    'lede uses incumbent provenance and does not call dated cash Current Balance');

  composer.applyUnavailableOperatingChrome(false, OPENING, { applied: true }, doc);
  ok(doc.store.heading.textContent === 'This payday'
      && doc.store.kicker.textContent === 'This payday',
    'trusted chrome restores This payday');

  const stubIds = {};
  const stubDoc = {
    getElementById(id) {
      stubIds[id] = stubIds[id] || { id };
      return stubIds[id];
    },
  };
  let stubThrew = false;
  try {
    composer.applyUnavailableOperatingChrome(true, OPENING, {
      applied: false,
      historicalOpeningAsOf: OPENING,
      operatingPlan: 'unavailable',
    }, stubDoc);
  } catch (err) {
    stubThrew = true;
  }
  ok(!stubThrew,
    'unavailable chrome is a no-op on stub nodes that have no querySelector');
}

console.log('\n=== 5. trusted control keeps the normal This payday waterfall ===');
{
  const trusted = F.recommend(liveData.plan, OPENING, {
    debts: liveData.debts,
    revolvingExtra: liveData.revolvingExtra,
    targetBuffer: liveData.plan.defaults.targetBuffer,
  });
  const html = composer.operatingSurfaceHtml({
    advice: trusted,
    weekly: trusted.weekly,
    recommended: trusted.weekly,
  });
  ok(trusted.operatingPlanUnavailable !== true
      && /data-calendar-waterfall/.test(html)
      && /<h2>Current balance<\/h2>/.test(html)
      && /data-pay-period-swipe/.test(html)
      && !/data-unavailable-primary/.test(html)
      && !/data-last-trusted-opening/.test(html),
    'trusted operating plan still prints This payday / pay-period / waterfall experience');
  ok(near(Number(trusted.defaultView.currentBalance), CHEQUING_CASH),
    'trusted control does not move current figures');
  const liveAmount = /data-live-current-balance-amount>([^<]+)/.exec(html);
  ok(HUB_CASH != null
      && liveAmount
      && liveAmount[1] === composer.money2(HUB_CASH)
      && /<h2>Current balance<\/h2>/.test(html)
      && !near(HUB_CASH, CHEQUING_CASH)
      && !near(HUB_CASH, DATED_CASH),
    'trusted waterfall prints independent hub (chequing-a) cash as Current Balance, not pooled A+B and not the savings-inclusive dated opening');
}

console.log('\n=== 6. page remains a renderer; Forecast is unchanged ===');
{
  const planSrc = read('public/plan.js');
  const forecastSrc = read('public/forecast.js');
  const surfaceFn = /function operatingSurfaceHtml\([\s\S]*?\n\}/.exec(planSrc);
  const unavailableFn = /function unavailableOperatingSurfaceHtml\([\s\S]*?\n\}/.exec(planSrc);
  ok(surfaceFn && /liveOperatingPlanUnavailable/.test(surfaceFn[0])
      && /unavailableOperatingSurfaceHtml/.test(surfaceFn[0])
      && !/\bForecast\.[A-Za-z]+\s*\(/.test(surfaceFn[0]),
    'operatingSurfaceHtml uses one root-level unavailable branch and calls no Forecast function');
  ok(unavailableFn && /data-unavailable-primary/.test(unavailableFn[0])
      && /Last trusted opening/.test(unavailableFn[0])
      && /Dated balance — not current/.test(unavailableFn[0])
      && !/\bForecast\.[A-Za-z]+\s*\(/.test(unavailableFn[0])
      && !/\.reduce\(/.test(unavailableFn[0]),
    'unavailableOperatingSurfaceHtml is presentation-only');
  ok(/applyUnavailableOperatingChrome\(planUnavailable, asOf, d\.liveOverlay\)/.test(planSrc),
    'renderPlan applies unavailable heading chrome from the same fail-closed verdict');
  ok(/function withholdCurrentOperatingClaims/.test(forecastSrc)
      && /opts\.operatingPlan !== 'unavailable'/.test(forecastSrc),
    'Forecast unavailable withhold path is unchanged by this presentation PR');
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
