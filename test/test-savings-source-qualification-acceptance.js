'use strict';
// Synthetic acceptance of reserve evidence and its current/future consumers.
// The existing fixture supplies the independent operating ledger; only reserve
// observations go through the real provider observer here. This is not a full
// live-overlay, server-cache, browser, or household acceptance test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const F = require('../public/forecast');
const O = require('../scripts/provider-observe');
const fx = require('./fixtures/savings-v2-observation-data');
const LmGroups = require('./lm-groups-fixture.js');

const DATE_HOLD = 'Both savings accounts require current, clear CAD cents evidence.';
const PENDING_HOLD = 'Pending savings movement withholds backing and contributions; known posted stock is retained.';
const CARD_HOLD = 'Card payment sent; cash inclusion or issuer minimum satisfaction is unconfirmed. Additional cash is unknown.';

function publish(input) {
  const before = JSON.stringify(input);
  const report = O.observe({ provider: 'lunchmoney', ...input });
  const reportBefore = JSON.stringify(report);
  const plan = { ...LmGroups.groupPlan(input.data.plan), savingsPoolObservation: report.savingsPools };
  const overlay = input.data.liveOverlay && input.data.liveOverlay.currentPeriodActuals
    ? { ...input.data.liveOverlay, currentPeriodActuals: LmGroups.groupPacket(input.data.liveOverlay.currentPeriodActuals, plan) }
    : input.data.liveOverlay;
  const advice = F.recommend(plan, input.data.meta.asOf,
    { weeklyVariable: 40, debts: input.data.debts, ...overlay });
  assert.equal(JSON.stringify(input), before, 'no source dates or financial inputs are rewritten');
  assert.equal(JSON.stringify(report), reportBefore, 'Forecast does not upgrade the observer packet');
  return { input, report, advice, funding: advice.savingsFunding };
}

function reported(x, day) {
  // Invented posted reports: 9500 + 2400 cents. Earmarking is separate from
  // qualified bank backing, new contributions and permission to move money.
  assert.equal(x.advice.savingsInventory.reportedStock.amount, 119);
  assert.equal(x.funding.goalAllocation.status, 'ready');
  assert.equal(x.funding.goalAllocation.evidenceTrust, 'provider-reported');
  assert.equal(x.funding.goalAllocation.checkedAsOf, x.input.data.meta.asOf);
  assert.deepEqual(x.funding.goalAllocation.balanceDates.map(r => r.date), [day, day]);
  assert.deepEqual(x.funding.rows.map(r => r.saved), [95, 24]);
  assert.equal(x.funding.moneyMovementPermission, 'not-granted');
  assert.equal(x.funding.actionPermission, 'not-granted');
}

function heldAcrossPeriods(x, reason, closingReason = reason) {
  assert.equal(x.funding.period.status, 'unavailable');
  assert.equal(x.funding.period.reason, reason);
  assert.equal(x.funding.period.proposal, null);
  assert.equal(x.funding.period.availableNow, null);
  // Check two independently selected future closes. No unavailable value may
  // become a zero, an estimated stock, or a permission merely by selecting it.
  for (const start of ['2026-10-16', '2026-10-30']) {
    const view = x.funding.periodViews.find(r => r.start === start);
    assert.ok(view, 'selected future period exists');
    const packet = F.savingsFundingPublication(x.funding,
      { asOf: x.input.data.meta.asOf, advice: x.advice, periodId: view.id });
    assert.equal(packet.period.status, 'unavailable');
    assert.equal(packet.period.proposal, null);
    assert.equal(packet.forecastClosing.status, 'unavailable');
    assert.equal(packet.forecastClosing.reason, closingReason);
    assert.equal(packet.forecastClosing.stock, null);
    assert.equal(packet.forecastClosing.actualSaved, null);
    assert.equal(packet.forecastClosing.trust, 'unknown');
    assert.equal(packet.forecastClosing.start, start);
    assert.equal(packet.forecastClosing.moneyMovementPermission, 'not-granted');
  }
}

function reserveDate(input, stamp) {
  input.payload.accounts.slice(2).forEach(r => { r.balance_last_update = stamp; });
  return input;
}

test('a successful current fetch of yesterday balances retains earmarks and the exact closing hold', () => {
  const input = reserveDate(fx.input(), '2026-10-04T19:00:00Z');
  const x = publish(input);
  assert.equal(input.payload.fetchedAt, '2026-10-05T20:00:00Z');
  assert.equal(x.report.observationReceipt.readyForReconciliation, true,
    'source retrieval qualification does not certify same-day reserve backing');
  assert.equal(x.report.savingsPools.asOf, '2026-10-05');
  reported(x, '2026-10-04');
  assert.equal(x.advice.savingsInventory.observedStock.amount, null);
  assert.equal(x.funding.backing.reason, DATE_HOLD);
  heldAcrossPeriods(x, DATE_HOLD);
});

test('genuinely current reserve evidence permits the independently proven current ledger only', () => {
  const x = publish(fx.input());
  reported(x, '2026-10-05');
  assert.equal(x.report.observationReceipt.readyForReconciliation, true);
  assert.equal(x.advice.savingsInventory.observedStock.amount, 119);
  assert.equal(x.funding.backing.status, 'ready');
  // 200 posted cash - (80 category budget - 20 already spent) - 40 routine
  // bill - 20 buffer = 80 available; the already-paid payroll is not added again.
  assert.equal(x.funding.period.currentCash, 200);
  assert.equal(x.funding.period.futureIncome, 0);
  assert.equal(x.funding.period.availableNow, 80);
  assert.equal(x.funding.period.proposal, 80);
});

for (const mode of ['missing', 'incomplete', 'bounded']) test('unknown pending coverage remains a distinct hold: ' + mode, () => {
  const input = fx.input();
  if (mode === 'missing') delete input.payload.pendingCoverage;
  if (mode === 'incomplete') input.payload.pendingCoverage.complete = false;
  if (mode === 'bounded') input.payload.pendingCoverage.basis = 'transaction-window';
  const x = publish(input);
  reported(x, '2026-10-05');
  assert.equal(x.report.observationReceipt.readyForReconciliation, false);
  assert.deepEqual(x.report.observationReceipt.balanceCoverage.requiredCashMissingDatedBalance, []);
  assert.deepEqual(x.report.savingsPools.accounts.map(r => r.pendingState), ['unknown', 'unknown']);
  assert.equal(x.advice.savingsInventory.observedStock.amount, 119, 'known posted stock survives');
  assert.equal(x.advice.savingsInventory.observedStock.pendingState, 'unresolved');
  assert.equal(x.funding.backing.reason, PENDING_HOLD);
  heldAcrossPeriods(x, PENDING_HOLD);
});

for (const value of [null, 'not-a-date', '2026-02-30T19:00:00Z', ['2026-10-05']])
  test('invalid v2 balance evidence cannot borrow a current fetch/update date: ' + JSON.stringify(value), () => {
    const input = reserveDate(fx.input(), value);
    input.payload.accounts.slice(2).forEach(r => { r.updated_at = input.payload.fetchedAt; });
    const x = publish(input);
    assert.equal(x.report.observationReceipt.readyForReconciliation, false);
    assert.deepEqual(x.report.savingsPools.accounts.map(r => r.evidenceDate), [null, null]);
    assert.equal(x.advice.savingsInventory.reportedStock.amount, null, 'invalid evidence is unavailable, not a zero');
    assert.equal(x.funding.goalAllocation.status, 'unavailable');
    assert.equal(x.advice.savingsInventory.observedStock.amount, null);
    heldAcrossPeriods(x, DATE_HOLD);
  });

test('the Vancouver day boundary changes reserve qualification without relabeling the prior instant', () => {
  const input = fx.input('household-midnight-current');
  // The reused fixture advances its operating packet through October 6; keep
  // its original-query provenance consistent too, so it does not mask the date gate.
  input.data.liveOverlay.currentPeriodActuals.savingsFetchCoverage.endDate = '2026-10-06';
  const prior = publish(reserveDate(input, '2026-10-06T06:59:59.999Z'));
  reported(prior, '2026-10-05');
  assert.equal(prior.report.savingsPools.asOf, '2026-10-06');
  heldAcrossPeriods(prior, DATE_HOLD);
  const current = publish(reserveDate(input, '2026-10-06T07:00:00.000Z'));
  reported(current, '2026-10-06');
  assert.equal(current.advice.savingsInventory.observedStock.amount, 119);
  assert.equal(current.funding.backing.status, 'ready');
  assert.equal(current.funding.period.availableNow, 80);
  assert.deepEqual(prior.report.savingsPools.accounts.map(r => r.evidenceDate), ['2026-10-05', '2026-10-05'],
    'a later evaluation does not restamp the earlier observation');
});

test('qualifying only reserve dates cannot clear an independent card payment hold', () => {
  const input = reserveDate(fx.input('sender-unknown'), '2026-10-04T19:00:00Z');
  const old = publish(input);
  reported(old, '2026-10-04');
  assert.equal(old.funding.backing.reason, DATE_HOLD);
  // Current funding sees the card hold first; future closing sees unqualified
  // reserve backing first. Qualifying reserves must leave the card hold intact.
  heldAcrossPeriods(old, CARD_HOLD, DATE_HOLD);
  const current = publish(reserveDate(input, '2026-10-05T19:00:00Z'));
  reported(current, '2026-10-05');
  assert.equal(current.funding.backing.status, 'ready');
  assert.equal(current.advice.cardMinimumPayments.status, 'unavailable');
  heldAcrossPeriods(current, CARD_HOLD);
});

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach(item => freeze(item, seen));
  return Object.freeze(value);
}

function budgetPage(x) {
  const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
  const page = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
    document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {},
      documentElement: { dataset: {}, style: {} } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  page.window = page;
  page.matchMedia = () => ({ matches: false, addEventListener() {} });
  for (const name of ['app', 'bill-detail', 'savings-inventory', 'budget-surface', 'plan']) {
    if (name === 'bill-detail') vm.runInContext('App.boot=()=>{};', page);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/' + name + '.js'), 'utf8'), page);
  }
  vm.runInContext('state.targetBuffer=20;state.extraDebtMonthly=0;state.debts=[];', page);
  page.src = { plan: { ...x.input.data.plan, savingsPoolObservation: x.report.savingsPools },
    debts: x.input.data.debts, asOf: x.input.data.meta.asOf, advice: x.advice,
    liveOverlay: x.input.data.liveOverlay, weekly: 40, weeklyOverride: 40 };
  return page;
}

// One invented source generation supplies all three selections. Yesterday's
// reserve evidence and the independent card hold must stay separate in the UI.
const heldSnapshot = freeze(publish(reserveDate(fx.input('sender-unknown'), '2026-10-04T19:00:00Z')));
for (const [start, label] of [
  ['2026-10-02', 'Oct 2–Oct 15'],
  ['2026-10-16', 'Oct 16–Oct 29'],
  ['2026-10-30', 'Oct 30–Nov 12'],
]) test('active Savings evidence retains both independent holds for ' + label, () => {
  const before = JSON.stringify(heldSnapshot);
  const page = budgetPage(heldSnapshot);
  page.period = heldSnapshot.advice.payPeriodViews.find(p => p.start === start);
  const packet = F.savingsFundingPublication(heldSnapshot.funding,
    { asOf: heldSnapshot.input.data.meta.asOf, advice: heldSnapshot.advice, periodId: page.period.id });
  const packetBefore = JSON.stringify(packet);
  assert.equal(packet.period.status, 'unavailable');
  assert.equal(packet.period.reason, CARD_HOLD);
  assert.equal(packet.period.proposal, null);
  assert.equal(heldSnapshot.funding.period.availableNow, null, 'current transfer capacity stays unavailable');
  assert.equal(packet.moneyMovementPermission, 'not-granted');
  if (start !== '2026-10-02') {
    assert.equal(packet.forecastClosing.status, 'unavailable');
    assert.equal(packet.forecastClosing.reason, DATE_HOLD);
    assert.notEqual(packet.period.reason, packet.forecastClosing.reason);
    for (const key of ['stock', 'actualSaved', 'contribution', 'projectedContributions', 'projectedDraws'])
      assert.equal(packet.forecastClosing[key] ?? null, null, key + ' remains unavailable');
    assert.equal(packet.forecastClosing.moneyMovementPermission, 'not-granted');
    assert.deepEqual(packet.plannedRequirements.rows, [], 'elapsed goals remain retired');
  }
  try {
    const html = vm.runInContext('budgetSavingsGoalsHtml(src,period,null)', page);
    assert.ok(html.includes('<p class="budget-surface-eyebrow">' + label + '</p>'), 'selected-period label');
    assert.match(html.split('data-budget-daily-proposal>')[1].split('</strong>')[0], /Unavailable/);
    if (start !== '2026-10-02') {
      assert.match(html, /No remaining Savings requirements\./);
      const reasons = html.split('data-budget-savings-info>')[1].split('<div class="operating-line">')[0];
      assert.ok(reasons.includes(DATE_HOLD), 'closing hold remains visible');
      assert.ok(reasons.includes(CARD_HOLD), 'independent period-funding hold remains visible');
    } else {
      assert.ok(html.includes(DATE_HOLD), 'current reserve-backing hold remains visible');
      assert.ok(html.includes(CARD_HOLD), 'current period-funding hold remains visible');
    }
  } finally {
    assert.equal(JSON.stringify(heldSnapshot), before, 'all selections preserve the source generation and advice');
    assert.equal(JSON.stringify(packet), packetBefore, 'rendering preserves the published packet');
  }
});

test('projected hold presentation escapes published text, deduplicates it and excludes ready-period prose', () => {
  const page = budgetPage(heldSnapshot);
  page.packet = JSON.parse(JSON.stringify(F.savingsFundingPublication(heldSnapshot.funding,
    { asOf: heldSnapshot.input.data.meta.asOf, advice: heldSnapshot.advice, periodId: 'next-pay-period' })));
  const preamble = () => vm.runInContext('budgetDailySavingsHtml(packet)', page)
    .split('data-budget-savings-info>')[1].split('<div class="operating-line">')[0];
  page.packet.period.reason = DATE_HOLD;
  assert.equal(preamble().split(DATE_HOLD).length - 1, 1, 'one copy of an identical published reason');
  page.packet.period.reason = 'Period <hold> & "unconfirmed"';
  const escaped = preamble();
  assert.ok(escaped.includes('Period &lt;hold&gt; &amp; &quot;unconfirmed&quot;'));
  assert.ok(escaped.includes(DATE_HOLD), 'separate closing hold survives');
  assert.ok(!escaped.includes('Period <hold>'), 'published reason cannot become markup');
  page.packet.period.status = 'ready';
  assert.ok(!preamble().includes('unconfirmed'), 'ready-period explanation is not presented as a hold');
});
