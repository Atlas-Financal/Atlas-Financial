'use strict';
// Dale, 2026-11-18: "The budget page for no reason should ever go blank."
// and "If we have a failure where the whole page goes down we should just keep
// it at the last full picture." Section 6: when today's refresh fails, the
// retained last full picture (already served wholesale by the server) shows
// unchanged under a banner, in a muted state. Sections 1-5: with no picture
// retained, the fallback.
// When the current plan is withheld as a whole (liveOverlay.operatingPlan
// 'unavailable'), the Budget surface used to drop the whole current pay
// period. It now keeps it as a shell: the period's dates, each figure
// (income, bills, household budget, Balance After Deductions, spending this
// period, available now) as "Unknown" with the withhold reason, and the bank
// balances exactly as observed (the dated latest Bills balance, the card
// strip). Forecast withholds this period's figures in that state, so the
// shell prints no number: nothing is filled in from the plan, a fallback or
// a stale balance, and forward walks and proposals stay withheld. A
// card-coverage hold already keeps the normal page; a healthy world is
// unchanged. Invented data only.
//
// Representative causes of the whole-plan hold:
//   B1 no complete refresh retained (live-plan withoutCompleteRefresh);
//   B2 a live refresh that failed closed on a later observation date;
//   B3 income reconciliation unavailable (an early deposit to confirm).
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { world } = require('./fixtures/card-coverage-aggregate-world');
const Live = require('../scripts/live-plan');

const ROOT = path.join(__dirname, '..');
let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };

const mk = id => {
  const el = { id, textContent: '', style: {}, attributes: {}, children: [], addEventListener() {}, setAttribute() {},
    removeAttribute() {}, appendChild(c) { return c; }, append() {}, remove() {}, insertAdjacentHTML() {}, querySelectorAll: () => [] };
  let h = ''; Object.defineProperty(el, 'innerHTML', { get: () => h, set(v) { h = String(v); } });
  return el;
};
const sb = {
  document: { getElementById: mk, createElement: () => mk('c'), createElementNS: () => mk('s'), querySelector: () => null,
    querySelectorAll: () => [], documentElement: mk('html'), body: { scrollHeight: 0 } },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, addEventListener() {}, matchMedia: () => ({ addEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }), requestAnimationFrame() {}, innerWidth: 1200, innerHeight: 800, scrollY: 0,
  console: { log() {}, warn() {}, error() {}, info() {} }, fetch: () => new Promise(() => {}),
};
sb.window = sb; sb.globalThis = sb; Object.assign(sb, { AbortController, setTimeout, clearTimeout });
vm.createContext(sb);
// The page's own script order (public/index.html), up to plan.js.
for (const f of ['app.js', 'display-name.js', 'forecast-card-period.js', 'forecast.js', 'forecast-chequing.js', 'balance-history.js',
  'bill-detail.js', 'savings-inventory.js', 'budget-surface.js', 'budget-card-movements.js', 'plan.js'])
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), sb, { filename: 'public/' + f });
const page = name => vm.runInContext(name, sb);
const F = sb.Forecast;

const AS_OF = '2026-09-20';
const purchase = ['card', 80, null, 'purchase'];
const paidLeg = ['bills', 105, null, 'cash', { payee: 'AB123 TFR-TO C/C', original_name: 'AB123 TFR-TO C/C',
  category_name: 'Transfer', notes: 'card payment: Travel Visa ...9999' }];
const observed = rows => Live.fromObservation(world(rows)).data;
function render(d) {
  const advice = F.recommend(d.plan, AS_OF, F.budgetRecommendInputs(d, {}));
  const html = page('budgetSurfaceHtml')({ advice, liveOverlay: d.liveOverlay, plan: d.plan, debts: d.debts, asOf: AS_OF,
    refreshTrust: d.refreshTrust });
  return { advice, html };
}
const section = (html, kind) => {
  const i = html.indexOf(`data-budget-surface-section="${kind}"`);
  return i < 0 ? '' : html.slice(i, html.indexOf('</section>', i));
};
const ROWS = ['income', 'bills', 'household', 'balance-after-deductions', 'spending', 'available-now'];

function shellHolds(d, why, reasonText) {
  const { advice, html } = render(d);
  check(advice.payPeriodViews.some(v => v.timelineRole === 'current'), why + ': Forecast still names the current pay period');
  check(/data-budget-surface="unavailable"/.test(html), why + ': the whole-plan hold is in force');
  const shell = section(html, 'period-unknown');
  check(shell.includes('data-budget-unavailable-shell'), why + ': the current pay period stays on the page (never blank)');
  check(shell.includes('This pay period · Sep 18 – Oct 1'), why + ': with its dates');
  for (const key of ROWS) {
    const m = shell.match(new RegExp(`data-unavailable-shell-row="${key}">\\s*<dt>[^<]+</dt><dd data-trust="unknown" title="[^"]*">Unknown</dd>`));
    check(m, `${why}: ${key} reads Unknown, tagged unknown, its reason in the title`);
  }
  check(!/\$|\d+\.\d\d/.test(shell.replace(/Sep 18 – Oct 1/, '')), why + ': no plan figure renders as a number in the shell');
  check(shell.includes('data-unavailable-shell-reason') && shell.includes(reasonText), why + ': the withhold reason is printed');
  // Bank balances stay as observed: the unavailable card prints only the
  // dated latest balance, never a balance passed off as today's plan.
  const card = section(html, 'unavailable');
  for (const amount of card.match(/\$[\d,]+\.\d\d/g) || [])
    check(new RegExp('Latest recorded Bills balance: \\' + amount.replace(/[.,]/g, c => '\\' + c) + ', dated').test(card),
      `${why}: ${amount} on the unavailable card is the dated latest balance only`);
  check(!/data-budget-surface="pay-period"/.test(html) && !/payday-hero/.test(html), why + ': no spend permission or proposal');
  return html;
}

console.log('1. B1: no complete refresh retained');
const b1 = Live.withoutCompleteRefresh(observed([purchase, paidLeg]));
check(b1.liveOverlay.operatingPlan === 'unavailable', 'B1 sets the whole-plan hold');
shellHolds(b1, 'B1', 'no complete refresh is retained');

console.log('2. B2: a live refresh that failed closed on a later observation date');
{
  const d = observed([purchase, paidLeg]);
  d.liveOverlay = { ...d.liveOverlay, applied: false, operatingPlan: Live.OPERATING_PLAN_UNAVAILABLE,
    operatingPlanNote: Live.OPERATING_PLAN_UNAVAILABLE_NOTE, historicalOpeningAsOf: '2026-09-18', observedAsOf: AS_OF,
    note: 'Live overlay failed closed. Current plan unavailable; dated opening is stale.' };
  shellHolds(d, 'B2', Live.OPERATING_PLAN_UNAVAILABLE_NOTE.slice(0, 40));
}

console.log('3. B3: income reconciliation unavailable');
{
  const d = observed([purchase, paidLeg]);
  d.plan.opening = { ...(d.plan.opening || {}), asOf: d.plan.opening?.asOf || '2026-09-18' };
  d.plan.opening.incomeReconciliation = { asOf: d.plan.opening.asOf, status: 'unavailable',
    issues: [{ id: 'invented-pay', date: '2026-10-02', reason: 'posted-income-occurrence-unresolved' }] };
  const state = F.incomeReconciliationState(d.plan, AS_OF);
  check(state.status === 'unavailable', 'the invented early deposit makes income reconciliation unavailable');
  d.liveOverlay = { ...d.liveOverlay, operatingPlan: Live.OPERATING_PLAN_UNAVAILABLE, operatingPlanNote: state.reason };
  shellHolds(d, 'B3', 'Early deposit to confirm');
}

console.log('4. Unchanged where the plan is not withheld as a whole');
{
  const healthy = render(observed([purchase, paidLeg])).html;
  check(/data-budget-surface="pay-period"/.test(healthy) && !healthy.includes('data-budget-unavailable-shell'),
    'a healthy world keeps the normal page and has no shell');
  // A card-coverage hold (an unpaired credit back into Bills) withholds only
  // the coverage figures: the normal page stays, with no shell.
  const held = render(observed([purchase, ['bills', -105, null, 'cash']]));
  check(held.advice.cardPurchaseCoverage.status === 'unavailable', 'the coverage hold is in force');
  check(/data-budget-surface="pay-period"/.test(held.html) && !held.html.includes('data-budget-unavailable-shell'),
    'a card-coverage hold keeps the normal page and has no shell');
}

console.log('5. The reason is escaped');
{
  const d = Live.withoutCompleteRefresh(observed([purchase, paidLeg]));
  d.liveOverlay.operatingPlanNote = '<img src=x onerror=alert(1)>"';
  const { html } = render(d);
  const shell = section(html, 'period-unknown');
  check(!shell.includes('<img') && shell.includes('&lt;img') && !/title="[^"]*"[^>]*onerror/.test(shell), 'markup in the reason never reaches the page raw');
  check(shell.includes('data-budget-unavailable-shell'), 'and the shell still renders');
}

console.log('6. A retained last full picture is shown unchanged, under a banner (Dale, 2026-11-18)');
{
  // The server serves the retained last complete publication wholesale when
  // today's refresh fails (live-plan withLatestCompleteRefresh).
  const base = observed([purchase, paidLeg]);
  const picture = Live.withLatestCompleteRefresh({ data: base, checkedAt: '2026-09-20T17:00:00Z' },
    { source: 'provider', qualified: false, checkedAt: '2026-09-21T16:30:00Z', attemptedAt: '2026-09-21T16:30:00Z',
      reason: 'provider-unavailable' });
  const plain = render(base).html, shown = render(picture).html;
  const banner = (shown.match(/<p class="note-box budget-retained-banner" role="status" data-budget-retained-banner>([^<]*)<\/p>/) || [])[1];
  check(banner === 'Showing the last full picture from Sep 20, 2026, 10:00 a.m. PDT. Today\'s update couldn\'t be completed: the bank connection did not answer.',
    'the banner names the picture\'s time and a one-line reason (got ' + banner + ')');
  check(/data-budget-surface="pay-period"/.test(shown) && !shown.includes('data-budget-unavailable-shell'), 'the full page is shown, not the shell');
  check(/<div class="budget-retained-picture" data-budget-retained-picture>/.test(shown), 'the page is in its muted state');
  check(!/data-latest-complete-refresh/.test(shown), 'the banner replaces the dated-plan note here');
  // The bank's own last sync stays as the small line beside it, when known.
  const synced = structuredClone(picture);
  synced.liveOverlay.currentPeriodActuals.lastSuccessfulSyncAt = '2026-09-19T18:30:00Z';
  const syncedHtml = render(synced).html;
  check(/data-budget-retained-banner/.test(syncedHtml) && /data-account-last-updated><small>Last updated Sep 19, 2026/.test(syncedHtml),
    'the bank\'s own (older) last sync still shows beside the banner');
  check(/data-budget-evidence-dated="2026-09-20"/.test(shown), 'the period chip still reads as of the picture\'s day');
  const amounts = html => (html.match(/\$[\d,]+\.\d\d/g) || []).sort().join(' ');
  check(amounts(shown) === amounts(plain) && amounts(shown).length > 0,
    'every amount is exactly the publication\'s own: nothing recomputed or mixed in');
  check(!/data-budget-retained-banner|data-budget-retained-picture/.test(plain), 'a current page has no banner and no muted state');
  // Reasons come from the closed set; anything else reads the default line.
  const odd = Live.withLatestCompleteRefresh({ data: base, checkedAt: '2026-09-20T17:00:00Z' },
    { source: 'provider', checkedAt: null, attemptedAt: null, reason: '<b>x</b>' });
  check(render(odd).html.includes("Today's update couldn't be completed: the current bank data is unavailable."),
    'an unknown reason reads the default line');
  // A complete refresh withheld as a whole shows the last non-withheld picture
  // (test/test-last-non-withheld-picture.js) with its own line.
  const withheldToday = Live.withLatestCompleteRefresh({ data: base, checkedAt: '2026-09-20T17:00:00Z' },
    { source: 'provider', checkedAt: '2026-09-21T16:30:00Z', attemptedAt: '2026-09-21T16:30:00Z', reason: 'current-plan-withheld' });
  check(render(withheldToday).html.includes("Today's update couldn't be completed: today&#39;s figures are on hold until something is confirmed."),
    'the withheld-today reason reads its own line');
  const badTime = JSON.parse(JSON.stringify(picture));
  badTime.liveOverlay.retainedRefresh.observedAt = '<img src=x onerror=alert(1)>';
  const badHtml = render(badTime).html;
  check(badHtml.includes('Showing the last full picture from an earlier refresh (time unavailable).') && !badHtml.includes('<img'),
    'an unreadable time is never printed raw');
  // No retained picture (a cold restart with the provider down): the shell.
  check(render(Live.withoutCompleteRefresh(base)).html.includes('data-budget-unavailable-shell'),
    'with no picture retained, the shell-with-unknowns is the fallback');
}

console.log(`\nAll Budget shell checks passed (${checks}).`);
process.exit(0);
