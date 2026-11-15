'use strict';
// Invented observer -> Forecast -> real Budget printers. The expected report
// is supplied independently: 95 + 24 = 119, never a sum in either renderer.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = process.env.ATLAS_TEST_APP_ROOT || path.join(__dirname, '..');
const F = require(path.join(root, 'public/forecast'));
const O = require(path.join(root, 'scripts/provider-observe'));
const UI = require(path.join(root, 'public/savings-inventory'));
const fx = require('./fixtures/savings-v2-observation-data');

const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {},
  classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {},
  querySelector() { return null; }, querySelectorAll() { return []; } });
const page = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
  document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {},
    documentElement: { dataset: {}, style: {} } },
  localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
page.window = page; page.matchMedia = () => ({ matches: false, addEventListener() {} });
for (const name of ['app', 'savings-inventory', 'plan']) {
  if (name === 'plan') vm.runInContext('App.boot=()=>{};', page);
  vm.runInContext(fs.readFileSync(path.join(root, 'public', name + '.js'), 'utf8'), page);
}
const line = html => html.match(/<p[^>]*data-savings-reported-balance[^>]*>.*?<\/p>/s)?.[0];
let checks = 0;
for (const mode of ['valid-v2', 'stale-date', 'stale-both', 'pending-movement', 'negative-stale', 'zero-stale',
  'sender-unknown', 'missing-date', 'missing-account', 'foreign-currency']) {
  const input = fx.input(mode);
  const report = O.observe({ provider: 'lunchmoney', ...input });
  input.data.plan.savingsPoolObservation = report.savingsPools;
  // Deliberately disagreeing stored opening figures are never the report.
  input.data.plan.startingCash.heldElsewhere[0].value = 9876.54;
  const before = JSON.stringify(input);
  const advice = F.recommend(input.data.plan, input.data.meta.asOf,
    { weeklyVariable: 40, debts: input.data.debts, ...input.data.liveOverlay });
  page.src = { plan: input.data.plan, asOf: input.data.meta.asOf, advice };
  page.period = advice.payPeriodViews.find(p => p.timelineRole === 'current');
  const html = vm.runInContext('budgetSavingsGoalsHtml(src, period, null)', page);
  const packet = F.savingsFundingPublication(advice.savingsFunding, { asOf: input.data.meta.asOf, advice });
  const visible = line(html);
  assert.ok(visible, mode + ': the Savings card directly prints a report or Unavailable');
  assert.equal(visible, line(UI.html(packet, { asOf: input.data.meta.asOf, advice, plan: input.data.plan })),
    mode + ': Info and card use identical date, amount, trust and uncertainty wording');
  const missing = ['missing-date', 'missing-account', 'foreign-currency'].includes(mode);
  if (missing) {
    assert.match(visible, /Unavailable/); assert.doesNotMatch(visible, /\$/);
  } else {
    assert.match(visible, new RegExp(mode === 'negative-stale' ? '-\\$3\\.12' : mode === 'zero-stale' ? '\\$0\\.00' : '\\$119\\.00'));
    assert.match(visible, /calculated.*provider-reported/);
    assert.match(visible, /Balance dates 2026-/);
  }
  if (mode.includes('stale')) assert.match(visible, /Dated balance — not current/);
  if (mode === 'stale-date') assert.match(visible, /2026-10-04 - 2026-10-05/);
  if (mode === 'pending-movement') assert.match(visible, /Pending movement evidence is unresolved/);
  assert.doesNotMatch(visible, /9,876|spendable|available to spend|verified/i);
  assert.equal(JSON.stringify(input), before, mode + ': rendering changes no inputs');
  page.period = advice.payPeriodViews.find(p => p.timelineRole === 'future');
  if (page.period) assert.equal(line(vm.runInContext('budgetSavingsGoalsHtml(src, period, null)', page)), undefined,
    'selected future period never borrows the current report');
  checks++;
}
assert.match(UI.reportedStockHtml(null), /Unavailable/);
assert.equal(UI.reportedStockHtml({ period: { kind: 'historical' } }), '');
assert.equal(UI.reportedStockHtml({ period: { kind: 'projected' } }), '');
const stored = UI.html({ status: 'ready', asOf: '2026-08-19', pools: [], goals: [] });
assert.match(stored, /Stored opening evidence, as of 2026-08-19\. Current combined reported balance is unavailable/);
// G2: before the combined policy applies, a failed refresh still publishes
// the last dated report on the inventory even when the daily stock omits it.
const H = require('./acceptance/harness');
const Live = require(path.join(root, 'scripts/live-plan'));
const w = H.baseWorld(); w.savingsPool = {};
w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
const good = H.dataOf(w).data;
const failed = structuredClone(good);
failed.meta.asOf = failed.plan.opening.asOf = '2026-10-13';
failed.plan.savingsEarmarks.allocationPolicy.effectiveFrom = '2026-10-14';
failed.plan.savingsPoolObservation = { asOf: '2026-10-13', accounts: [] };
failed.liveOverlay = { applied: false, operatingPlan: 'unavailable' };
const carried = Live.withCarriedSavingsEvidence(failed, good);
const carriedAdvice = F.recommend(carried.plan, carried.meta.asOf, { operatingPlan: 'unavailable' });
assert.equal(carriedAdvice.savingsInventory.reportedStock.freshness, 'carried');
assert.equal(carriedAdvice.savingsFunding.stock?.reportedStock, undefined);
page.src = { plan: carried.plan, asOf: carried.meta.asOf, advice: carriedAdvice };
page.period = carriedAdvice.payPeriodViews.find(p => p.timelineRole === 'current');
const carriedLine = line(vm.runInContext('budgetSavingsGoalsHtml(src, period, null)', page));
assert.match(carriedLine, /Reported combined savings: \$1,000\.00\./);
assert.match(carriedLine, /Balance dates 2026-10-14.*Dated balance — not current/s);
assert.doesNotMatch(carriedLine, /Unavailable/);
const legacy = require('./fixtures/savings-earmarks');
const currentLegacy = F.savingsInventory(legacy.observedPlan(), legacy.AS_OF);
assert.equal(currentLegacy.reportedStock.freshness, 'current');
assert.doesNotMatch(UI.html(currentLegacy), /data-savings-stored-opening|Not a current/,
  'independently current provider-qualified legacy accounts are not labelled old');
const datedLegacy = structuredClone(currentLegacy);
datedLegacy.reportedStock.freshness = 'dated';
datedLegacy.reportedStock.balanceFrom = datedLegacy.reportedStock.balanceThrough = '2026-08-18';
assert.match(UI.html(datedLegacy), /Dated savings evidence\. Balance dates 2026-08-18\. Not a current combined balance/,
  'old legacy evidence retains its real balance date, not the publication check date');
console.log('Savings balance discoverability: ' + checks + ' observer/Forecast/card/Info scenarios checked');
