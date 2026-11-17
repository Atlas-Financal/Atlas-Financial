'use strict';
/* A canonical opening dated on a payday prints the opening cash as the dated
 * balance, never that cash plus the day's planned pay (#821 finish-line audit,
 * finding 14b). Invented world only.
 *
 * Forecast's payday allocation publishes `available` = opening cash + the pay
 * landing on the opening day: the money a payday plan may allocate. The
 * unavailable page printed that as "Last trusted opening ... Dated balance",
 * a balance nobody holds. It now prints the opening cash Forecast publishes
 * (`opening`). When the pay is already in the opening's bank evidence the two
 * are equal, so nothing changes there.
 *
 *   node test/test-payday-opening-dated-cash.js
 */
const F = require('../public/forecast.js');
const shaw = require('./fixtures/shaw-posted-identity');

// The real Budget page (test/lib/budget-page-harness.js): operatingSurfaceHtml
// is the live composition, the unavailable surface or the Today card plus the
// compact pay-period content, with the same page state as
// test-plan-unavailable-surface.js.
const { loadBudgetPage } = require('./lib/budget-page-harness');
const composer = (() => {
  const page = loadBudgetPage({ Forecast: F, state: { scenario: null, targetBuffer: 500, extraDebtMonthly: 0,
    incomeOverrides: {}, disabled: [], debts: null, extraDebtTarget: null, extraFacilities: null } });
  return { operatingSurfaceHtml: ctx => page.surfaceHtml(ctx), money2: page.get('money2') };
})();

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const clone = x => JSON.parse(JSON.stringify(x));
const money = n => composer.money2(n);

const base = shaw('04', 'Shaw Cable');
const OPENING = base.data.plan.opening.asOf;                       // 2031-04-04
const CHEQUING = base.data.plan.startingCash.breakdown
  .filter(r => r.id !== 'savings').reduce((s, r) => s + r.value, 0);  // 500 + 100: the opening's household cash
const PAY = base.data.plan.income[0].amount;                        // 1000

// The dated world: canonical data only, no refresh.
const world = ({ payday, represented }) => {
  const plan = clone(base.data.plan);
  plan.income[0].anchor = payday ? OPENING : '2031-03-28';          // payday-dated opening, or not
  if (represented) plan.opening.representedEvents = [{ id: plan.income[0].id, date: OPENING }];
  return { meta: base.data.meta, plan, debts: [], revolvingExtra: [] };
};
const note = 'Current plan unavailable. The dated opening is stale.';
const advice = doc => F.recommend(doc.plan, OPENING, { debts: [], revolvingExtra: [],
  targetBuffer: doc.plan.defaults.targetBuffer, operatingPlan: 'unavailable', operatingPlanNote: note });
const page = doc => {
  const liveOverlay = { applied: false, operatingPlan: 'unavailable', operatingPlanNote: note, historicalOpeningAsOf: OPENING };
  const a = advice(doc);
  return composer.operatingSurfaceHtml({ advice: a, weekly: a.weekly, recommended: a.weekly, liveOverlay,
    refreshTrust: { displayState: 'attention-needed', overlayApplied: false, observedAsOf: null, reconciledAsOf: null,
      exactFiguresAvailable: false, remainingClaim: 'unavailable', coverageLimits: [], unresolvedMaterial: [],
      canonicalProposalWaiting: false, refreshPath: 'on-demand-reload' },
    asOf: OPENING });
};
const printedOpening = html => { const m = /data-last-trusted-opening-amount>([^<]*)</.exec(html); return m ? m[1] : null; };

console.log('\n=== 1. payday-dated opening: the dated balance is the opening cash ===');
{
  const doc = world({ payday: true });
  const a = advice(doc).paydayAllocation;
  ok(a.opening === CHEQUING && a.todayIncome === PAY && a.available === CHEQUING + PAY,
    'Forecast still publishes opening cash, the day\'s pay and the allocatable total (payday plan unchanged)',
    `opening ${a.opening}, pay ${a.todayIncome}, available ${a.available}`);
  const html = page(doc);
  ok(printedOpening(html) === money(CHEQUING), 'Last trusted opening prints the opening cash', printedOpening(html));
  ok(!html.includes(money(CHEQUING + PAY)), 'the cash plus the planned pay is not printed anywhere on the page');
  ok(/As at April 4\./.test(html) && /Dated balance — not current/.test(html), 'it stays dated and not current');
}

console.log('\n=== 2. control: a non-payday opening is unchanged ===');
{
  const doc = world({ payday: false });
  const a = advice(doc).paydayAllocation;
  ok(a.todayIncome === 0 && a.available === CHEQUING && a.opening === CHEQUING, 'no pay lands on the opening day');
  ok(printedOpening(page(doc)) === money(CHEQUING), 'it prints the opening cash, as before');
}

console.log('\n=== 3. the pay is already in the bank evidence: unchanged ===');
{
  const doc = world({ payday: true, represented: true });
  const a = advice(doc).paydayAllocation;
  ok(a.todayIncome === 0 && a.available === a.opening, 'the represented pay is not added to the opening');
  ok(printedOpening(page(doc)) === money(CHEQUING), 'it prints the opening cash, as before');
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nAll payday-opening-dated-cash checks passed.');
