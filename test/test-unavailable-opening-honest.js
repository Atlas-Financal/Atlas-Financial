'use strict';
/* "Last trusted opening" never pairs an untrusted amount with a trusted date
 * (#821 finish-line audit, finding 14a). Invented world only.
 *
 * Cold start plus an incomplete refresh: the served document is the refresh's
 * (today's cash, advanced as-of) with the operating plan withheld, while
 * liveOverlay.historicalOpeningAsOf is the older trusted opening date. The
 * unavailable page used to print the refresh's cash as the "Last trusted
 * opening" beside the old date. Now the amount is shown only when its own as-of
 * is the trusted opening's date, and is withheld otherwise.
 *
 *   node test/test-unavailable-opening-honest.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const Live = require('../scripts/live-plan.js');
const shaw = require('./fixtures/shaw-posted-identity');
const configured = require('../docs/connectivity/transaction-identity.json');

// Reuse the page composer the existing unavailable-surface suite loads.
const surfaceSrc = fs.readFileSync(path.join(__dirname, 'test-plan-unavailable-surface.js'), 'utf8');
const pull = re => { const m = re.exec(surfaceSrc); if (!m) throw new Error('missing ' + re); return m[0]; };
const { sourceText } = require('./test-source-text');
const ROOT = path.join(__dirname, '..');
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const grab = (src, re, label) => { const m = re.exec(src); if (!m) throw new Error('missing ' + label); return m[0]; };
const composer = (new Function('fs', 'path', 'vm', 'F', 'read', 'grab', 'ROOT',
  pull(/function loadComposer\(\) \{[\s\S]*?\n\}\n/) + '\nreturn loadComposer();'))(fs, path, vm, F, read, grab, ROOT);

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const clone = x => JSON.parse(JSON.stringify(x));
const observation = () => {
  const x = { ...shaw('04', 'Shaw Cable'), identity: { schema: configured.schema, rules: clone(configured.rules.filter(r => r.eventId === 'shaw')) } };
  // The invented opening day must not be a payday: a payday-dated opening is a
  // separate finding (14b), and this suite's expected cash is the plain opening.
  x.data.plan.income[0].anchor = '2031-03-28';
  return x;
};
const x = observation();
const TRUSTED = x.data.plan.opening.asOf;               // invented trusted opening: 2031-04-04
const TRUSTED_CHEQUING = x.data.plan.startingCash.breakdown
  .filter(r => r.id !== 'savings').reduce((s, r) => s + r.value, 0);   // 500 + 100, the canonical opening's cash
const refreshed = Live.fromObservation(x);
const REFRESH_DAY = refreshed.data.meta.asOf;            // 2031-04-15
const REFRESH_CHEQUING = refreshed.data.plan.startingCash.breakdown
  .filter(r => r.id !== 'savings').reduce((s, r) => s + r.value, 0);   // 482.77 + 100, today's cash from the refresh
const money = n => composer.money2(n);

const pageFor = (doc, overlayOverride) => {
  const overlay = { ...doc.liveOverlay, ...overlayOverride };
  const unavailable = overlay.operatingPlan === 'unavailable';
  const advice = F.recommend(doc.plan, doc.meta.asOf, {
    debts: doc.debts || [], revolvingExtra: doc.revolvingExtra || [], targetBuffer: doc.plan.defaults.targetBuffer,
    operatingPlan: overlay.operatingPlan, operatingPlanNote: overlay.operatingPlanNote,
  });
  const refreshTrust = { displayState: 'attention-needed', overlayApplied: overlay.applied === true,
    observedAsOf: overlay.observedAsOf || null, reconciledAsOf: null, exactFiguresAvailable: false,
    remainingClaim: 'unavailable', coverageLimits: [], unresolvedMaterial: [], canonicalProposalWaiting: false,
    refreshPath: 'on-demand-reload' };
  return composer.operatingSurfaceHtml({ advice, weekly: advice.weekly, recommended: advice.weekly,
    liveOverlay: overlay, refreshTrust, asOf: doc.meta.asOf, unavailable });
};

console.log('\n=== 1. the fixture is the audit scenario ===');
ok(TRUSTED !== REFRESH_DAY && refreshed.data.liveOverlay.historicalOpeningAsOf === TRUSTED,
  'the refresh advanced the as-of beyond the trusted opening', TRUSTED + ' -> ' + REFRESH_DAY);
ok(Math.abs(REFRESH_CHEQUING - TRUSTED_CHEQUING) > 1, 'the refresh cash differs from the trusted opening cash');

console.log('\n=== 2. cold start + incomplete refresh: no untrusted amount beside the trusted date ===');
{
  // What the server serves when the refresh is incomplete and nothing complete is retained.
  const served = Live.withoutCompleteRefresh(refreshed.data);
  const html = pageFor(served);
  ok(/data-operating-plan="unavailable"/.test(html), 'the page is the unavailable operating page');
  ok(!/data-last-trusted-opening/.test(html) && !/Last trusted opening/.test(html) && !/data-spendable-cash/.test(html),
    'the "Last trusted opening" amount block is withheld');
  ok(!html.includes(money(REFRESH_CHEQUING)) && !html.includes(money(TRUSTED_CHEQUING)),
    'neither the refresh cash nor an unpaired cash figure is printed');
  ok(/Last trusted financial opening is April 4\./.test(html),
    'the trusted date is still named in words, with no amount attached');
}

console.log('\n=== 3. dated-only unavailable page (no refresh): amount and date both from the trusted opening, unchanged ===');
{
  const dated = { meta: x.data.meta, plan: x.data.plan, debts: [], revolvingExtra: [],
    liveOverlay: { applied: false, operatingPlan: 'unavailable', historicalOpeningAsOf: TRUSTED,
      operatingPlanNote: 'Current plan unavailable. The dated opening is stale.' } };
  const html = pageFor(dated);
  ok(/data-last-trusted-opening/.test(html) && /Last trusted opening/.test(html), 'the line is printed');
  ok(html.includes(money(TRUSTED_CHEQUING)) && /As at April 4\./.test(html),
    'its amount is the trusted opening cash and its date is the trusted opening date');
  const noOverlayDate = pageFor({ ...dated, liveOverlay: { applied: false, operatingPlan: 'unavailable',
    operatingPlanNote: 'Current plan unavailable. The dated opening is stale.' } });
  ok(/data-last-trusted-opening/.test(noOverlayDate) && noOverlayDate.includes(money(TRUSTED_CHEQUING)),
    'with no separate trusted-opening date the dated plan is its own opening: unchanged');
}

console.log('\n=== 4. a good refresh is unchanged: no unavailable page and no Last trusted opening ===');
{
  const html = pageFor(refreshed.data);
  ok(!/data-operating-plan="unavailable"/.test(html) && !/data-last-trusted-opening/.test(html),
    'a complete refresh renders the live operating page, not the unavailable one');
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nAll unavailable-opening-honest checks passed.');
