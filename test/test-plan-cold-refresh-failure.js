'use strict';
/* PA-5 (#775) — a cold process whose first provider refresh fails must not
 * present the dated opening period as the current ("Now") operating plan.
 *
 * Synthetic overlay only (shape copied from the live-plan fail-closed path:
 * applied:false, operatingPlan:'dated-opening', no observed/effective date,
 * reason:'provider-unavailable'). No household evidence. Forecast and the
 * live-plan server are untouched; this proves the plan.js display predicate,
 * the unavailable surfaces it gates, and that the incumbent Forecast call is
 * given the same effective verdict (real public/forecast.js on the invented
 * budget-surface-data canonical() fixture: independent chequing 15 + 604.49 =
 * $619.49, Savings $0, dated 2026-08-13).
 *
 * Red on a03cf1c4 (predicate returns false for the cold-failure overlay),
 * green with the PA-5 repair.
 *
 * `node test/test-plan-cold-refresh-failure.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const planSrc = sourceText(fs.readFileSync(path.join(ROOT, 'public/plan.js'), 'utf8'));

let failures = 0;
let passes = 0;
const ok = (cond, label, detail = '') => {
  if (cond) passes++; else failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

function grab(re, label) {
  const m = re.exec(planSrc);
  if (!m) throw new Error('missing ' + label);
  return m[0];
}

const source = [
  'const money = n => "$" + Number(n).toFixed(2);',
  'const fmtDateLong = d => String(d);',
  'const addDays = (d, n) => d;',
  // The PA-5 predicate is Forecast's (finish-line audit finding 12); the page's
  // liveOperatingPlanUnavailable delegates to it, so the real one is supplied.
  'const Forecast = { nextPaymentOut: () => null, startingCashAmount: () => 619.49, liveOperatingPlanUnavailable: __pa5 };',
  grab(/^function liveOperatingPlanUnavailable\([\s\S]*?\n\}$/m, 'liveOperatingPlanUnavailable'),
  grab(/^function liveOperatingPlanNote\([\s\S]*?\n\}$/m, 'liveOperatingPlanNote'),
  grab(/^function currentOperatingUnavailableHtml\([\s\S]*?\n\}$/m, 'currentOperatingUnavailableHtml'),
  grab(/^function currentOperatingCashHeroTiles\([\s\S]*?\n\}$/m, 'currentOperatingCashHeroTiles'),
  grab(/^function currentOperatingConsumerDebtHeroTile\([\s\S]*?\n\}$/m, 'currentOperatingConsumerDebtHeroTile'),
].join('\n');
const P = vm.runInNewContext(`${source}\n({ liveOperatingPlanUnavailable, liveOperatingPlanNote, currentOperatingUnavailableHtml, currentOperatingCashHeroTiles, currentOperatingConsumerDebtHeroTile });`, { __pa5: require('../public/forecast.js').liveOperatingPlanUnavailable });

// The renderPlan caller's effective verdict, copied from its exact source
// expression (asserted below) and evaluated against the real predicate.
// Finish-line audit finding 12: the caller's inputs come from the one shared
// builder, which passes this exact effective verdict to recommend.
const CALLER_BUILDER = /operatingPlan: overlay && \(liveOperatingPlanUnavailable\(null, overlay\)\s*\? 'unavailable' : overlay\.operatingPlan\),/;
const CALLER = { test: src => /Forecast\.recommend\(plan, asOf, Forecast\.budgetRecommendInputs\(d,/.test(src)
  && CALLER_BUILDER.test(require('fs').readFileSync(require('path').join(__dirname, '../public/forecast.js'), 'utf8')) };
P.effectiveLiveOperatingPlan = o => o && (P.liveOperatingPlanUnavailable(null, o) ? 'unavailable' : o.operatingPlan);

// Synthetic fail-closed overlay, as served by a cold process whose first
// provider call failed (no household date was ever observed).
const coldFailed = () => ({
  schema: 'atlas-live-plan-overlay/v1',
  applied: false,
  historicalOpeningAsOf: '2026-08-13',
  effectiveAsOf: null,
  observedAsOf: null,
  overlays: [],
  note: 'Live overlay failed closed. Dated opening is unchanged.',
  reason: 'provider-unavailable',
  operatingPlan: 'dated-opening',
  operatingPlanNote: null,
});

console.log('PA-5 cold refresh failure: predicate');
ok(P.liveOperatingPlanUnavailable({}, coldFailed()) === true,
  'cold failed refresh (no observed date, failure reason) is plan-unavailable');
ok(P.liveOperatingPlanUnavailable(null, coldFailed()) === true,
  'same verdict with no advice object');
for (const reason of ['provider-unavailable', 'provider-timeout', 'observation-refused']) {
  ok(P.liveOperatingPlanUnavailable({}, Object.assign(coldFailed(), { reason })) === true,
    `any non-empty failure reason fails closed (${reason})`);
}

console.log('PA-5 cold refresh failure: unchanged paths');
ok(P.liveOperatingPlanUnavailable({}, Object.assign(coldFailed(), { operatingPlan: 'unavailable' })) === true,
  'incumbent operatingPlan:"unavailable" still unavailable');
ok(P.liveOperatingPlanUnavailable({ operatingPlanUnavailable: true }, null) === true,
  'incumbent advice.operatingPlanUnavailable still unavailable');
ok(P.liveOperatingPlanUnavailable({}, null) === false, 'no overlay: not unavailable');
ok(P.liveOperatingPlanUnavailable({}, undefined) === false, 'undefined overlay: not unavailable');
ok(P.liveOperatingPlanUnavailable({}, Object.assign(coldFailed(), { reason: null })) === false,
  'dated opening with no failure reason (no refresh attempted) unchanged');
ok(P.liveOperatingPlanUnavailable({}, Object.assign(coldFailed(), { reason: '' })) === false,
  'empty reason string unchanged');
ok(P.liveOperatingPlanUnavailable({}, Object.assign(coldFailed(), { observedAsOf: '2026-08-13' })) === false,
  'same-date observed overlay keeps incumbent verdict');
ok(P.liveOperatingPlanUnavailable({}, Object.assign(coldFailed(), { effectiveAsOf: '2026-08-13' })) === false,
  'effective date present keeps incumbent verdict');
ok(P.liveOperatingPlanUnavailable({}, Object.assign(coldFailed(), { applied: true })) === false,
  'applied overlay keeps incumbent verdict');
ok(P.liveOperatingPlanUnavailable({}, Object.assign(coldFailed(), { operatingPlan: 'live' })) === false,
  'non dated-opening plan keeps incumbent verdict');

console.log('PA-5 cold refresh failure: gated surfaces fail closed');
const html = P.currentOperatingUnavailableHtml({}, coldFailed());
ok(typeof html === 'string' && html.includes('data-operating-plan="unavailable"'),
  'current operating block renders the unavailable face');
ok(typeof html === 'string' && /dated opening is stale/i.test(html),
  'unavailable face says the dated opening is stale (dated, not current)');
ok(!/\bNow\b/.test(html || ''), 'unavailable face does not label the dated period "Now"');
const tiles = P.currentOperatingCashHeroTiles({}, '2026-08-13', { events: [] }, {}, coldFailed());
ok(tiles.length === 2 && tiles.every(t => t.val === 'unavailable'),
  'cash hero tiles withhold figures as unavailable', JSON.stringify(tiles.map(t => t.val)));
ok(!tiles.some(t => /619\.49/.test(String(t.val))), 'no stale cash figure presented as current');
const debt = P.currentOperatingConsumerDebtHeroTile({}, coldFailed(), { consumer: 1, headroom: 1, debts: [] });
ok(debt.val === 'unavailable', 'consumer debt tile withheld as unavailable');
ok(P.currentOperatingUnavailableHtml({}, Object.assign(coldFailed(), { reason: null })) === null,
  'control: no failure reason renders no unavailable block');

console.log('PA-5 cold refresh failure: Forecast caller gets the same verdict');
ok(CALLER.test(planSrc),
  'renderPlan passes the effective verdict to the incumbent Forecast.recommend call');
ok(P.effectiveLiveOperatingPlan(coldFailed()) === 'unavailable', 'cold failed refresh: effective verdict unavailable');
ok(P.effectiveLiveOperatingPlan(Object.assign(coldFailed(), { reason: null })) === 'dated-opening',
  'no refresh attempted: verdict unchanged (dated-opening)');
ok(P.effectiveLiveOperatingPlan(Object.assign(coldFailed(), { observedAsOf: '2026-08-13' })) === 'dated-opening',
  'same-date observation: verdict unchanged');
ok(P.effectiveLiveOperatingPlan(Object.assign(coldFailed(), { applied: true, operatingPlan: 'live',
  observedAsOf: '2026-08-21' })) === 'live', 'qualified later-date reacquisition: verdict unchanged');
ok(P.effectiveLiveOperatingPlan(null) == null, 'no overlay: no verdict passed');

const F = require('../public/forecast.js');
const Fixture = require('./fixtures/budget-surface-data');
const data = Fixture.canonical();
const breakdown = data.plan.startingCash.breakdown;
const chequing = breakdown.filter(r => r.id !== 'savings').reduce((a, r) => a + r.value, 0);
ok(Math.abs(chequing - 619.49) < 0.005 && breakdown.find(r => r.id === 'savings').value === 0,
  'independent oracle: fixture chequing 15 + 604.49 = $619.49, Savings $0');
const recommendWith = operatingPlan => F.recommend(data.plan, Fixture.OPENING, {
  debts: data.debts, revolvingExtra: data.revolvingExtra,
  targetBuffer: data.plan.defaults.targetBuffer, operatingPlan,
});
const effective = recommendWith(P.effectiveLiveOperatingPlan(coldFailed()));
ok(effective.operatingPlanUnavailable === true, 'Forecast given the effective verdict publishes plan-unavailable');
ok(Math.abs(Number(effective.defaultView.currentBalance) - 619.49) < 0.005,
  'Forecast dated currentBalance is the independent $619.49 chequing opening',
  String(effective.defaultView.currentBalance));
ok(effective.defaultView.asOf === Fixture.OPENING, 'Forecast keeps the dated as-of (no invented later date)',
  String(effective.defaultView.asOf));
ok(P.liveOperatingPlanUnavailable(effective, coldFailed()) === true,
  'display predicate and Forecast verdict agree on the cold failure');
const raw = recommendWith(coldFailed().operatingPlan);
ok(raw.operatingPlanUnavailable !== true,
  'control: the raw dated-opening verdict (pre-PA-5 caller) is what Forecast saw before',
  String(raw.defaultView && raw.defaultView.currentBalance));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
