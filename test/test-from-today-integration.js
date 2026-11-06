'use strict';
// Real observation -> reconciliation -> live overlay -> Forecast -> Budget
// renderer. Synthetic provider IDs and dollars only; no provider GET/write.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const os = require('node:os');
const path = require('node:path');
const Live = require('../scripts/live-plan');
const F = require('../public/forecast');
const fixture = require('./fixtures/budget-funding-data');
const AS_OF = '2026-08-20';
const data = fixture();
data.plan.cardPurchaseCoverage = require('./fixtures/card-coverage-opening')('2026-08-14');
data.plan.bills.push({ id: 'synthetic-due', label: 'Synthetic due bill', frequency: 'once',
  date: '2026-08-19', amount: 100, confidence: 'confirmed' });
data.plan.startingCash.breakdown = [
  { id: 'chequing-a', label: 'Synthetic Bills', value: 800 },
  { id: 'chequing-b', label: 'Synthetic Weekly', value: 0 },
  { id: 'savings', label: 'Synthetic savings including silver', value: 5000 },
];
data.debts = [{ id: 'travelvisa', label: 'Synthetic card', structure: 'Revolving',
  secured: false, balance: 400, pending: 0, limit: 1000, rate: 20 }];
const map = { schema: 'atlas-provider-account-map/v1', provider: 'lunchmoney', scope: 'fixture',
  mappings: [
    { providerAccountId: '1001', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
    { providerAccountId: '1002', canonical: { collection: 'cash', id: 'chequing-b' }, atlasRole: 'household-cash' },
    { providerAccountId: '1003', canonical: { collection: 'cash', id: 'savings' }, atlasRole: 'household-cash' },
    { providerAccountId: '2001', canonical: { collection: 'debts', id: 'travelvisa' }, atlasRole: 'revolving-credit' },
  ] };
const payload = { provider: 'lunchmoney', fetchedAt: AS_OF + 'T18:00:00.000Z',
  transactionWindow: { startDate: '2026-08-14', endDate: AS_OF, complete: true, hasMore: false, truncated: false },
  pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false, truncated: false },
  accounts: [
    { id: 1001, type: 'cash', balance: 800 }, { id: 1002, type: 'cash', balance: 0 },
    { id: 1003, type: 'cash', balance: 5000 }, { id: 2001, type: 'credit', balance: 400, credit_limit: 1000 },
  ].map(a => ({ ...a, currency: 'cad', updated_at: AS_OF + 'T17:55:00.000Z', balance_last_update: AS_OF + 'T17:55:00.000Z' })),
  categories: [{ id: 11, name: 'Groceries', is_income: false, exclude_from_totals: false },
    { id: 12, name: 'Income', is_income: true, exclude_from_totals: false }],
  transactions: [
    { id: 91001, account_id: 2001, date: '2026-08-19', amount: 50, currency: 'cad',
      payee: 'Synthetic grocer', category_id: 11, is_pending: true, status: 'unreviewed' },
    { id: 91002, account_id: 1001, date: '2026-08-14', amount: -1000, currency: 'cad',
      payee: 'Synthetic payroll', category_id: 12, is_pending: false, status: 'cleared' },
    { id: 91003, account_id: 1001, date: '2026-08-18', amount: -125, currency: 'cad',
      payee: 'Synthetic irregular receipt', category_id: 12, is_pending: false, status: 'cleared' },
  ] };
const identity = { schema: 'atlas-provider-transaction-identity/v1', rules: [{
  eventId: 'synthetic-due', payeePattern: 'Synthetic due bill',
  atlasAccountId: 'chequing-a', direction: 'debit',
}] };
const original = JSON.stringify({ data, payload, map, identity });
const diskBefore = fs.readFileSync(require.resolve('../data.json'), 'utf8');
function refresh(source = payload) {
  const overlay = Live.fromObservation({ data, payload: source, accountMap: map, identity });
  assert.equal(overlay.writesCanonicalState, false);
  assert.equal(overlay.data.liveOverlay.applied, true);
  const d = overlay.data;
  const advice = F.recommend(d.plan, d.meta.asOf, { debts: d.debts,
    currentPeriodActuals: d.liveOverlay.currentPeriodActuals,
    operatingPlan: d.liveOverlay.operatingPlan, observedCash: d.liveOverlay.observedCash });
  return { overlay, advice, current: advice.payPeriodViews.find(p => p.start === '2026-08-14') };
}
const first = refresh(), second = refresh();
const proposal = first.current.fromTodayFunding;
assert.equal(proposal.status, 'ready');
assert.equal(proposal.currentCash, 800, '125 irregular receipt and 1000 payroll already inside 800 cash');
assert.equal(proposal.remainingHousehold, 300 - 50);
assert.equal(proposal.operatingBills, 100, 'unsettled earlier bill remains reserved');
assert.equal(proposal.contribution, 600 - (1000 - 200 - 150 - 300));
assert.equal(first.current.plannedCostFunding.contribution, null);
assert.deepEqual(second.current, first.current, 'repeated provider refresh has no accumulation');
const duplicate = structuredClone(payload);
duplicate.transactions.push({ ...duplicate.transactions[2] });
assert.equal(refresh(duplicate).current.fromTodayFunding.contribution, null,
  'duplicate identity within one observation fails closed instead of creating another deposit');
assert.equal(first.overlay.data.debts[0].pending, 50);
assert.equal(JSON.stringify({ data, payload, map, identity }), original);
assert.equal(fs.readFileSync(require.resolve('../data.json'), 'utf8'), diskBefore);
const paidPayload = structuredClone(payload);
paidPayload.accounts[0].balance = 700;
paidPayload.transactions.push({ id: 91004, account_id: 1001, date: '2026-08-19', amount: 100, currency: 'cad',
  payee: 'Synthetic due bill', is_pending: false, status: 'cleared' });
const settled = refresh(paidPayload);
assert.ok(settled.overlay.data.plan.opening.representedEvents.some(e => e.id === 'synthetic-due'));
assert.equal(settled.current.fromTodayFunding.currentCash, 700);
assert.equal(settled.current.fromTodayFunding.operatingBills, 0);
assert.equal(settled.current.fromTodayFunding.availableNow, proposal.availableNow);
assert.equal(settled.current.fromTodayFunding.contribution, 250,
  'posting the bill and reducing cash releases only its existing hold');

// Execute the actual Budget page with its actual helpers. DOM boot is held
// for an explicit render, not replaced by a fake funding implementation.
const context = vm.createContext({ Forecast: F, console, addEventListener() {},
  document: { addEventListener() {}, querySelectorAll() { return []; },
    getElementById() { return null; }, documentElement: { dataset: {}, style: {} } },
  window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
  localStorage: { getItem() { return null; }, setItem() {} },
  location: { pathname: '/' },
});
vm.runInContext(fs.readFileSync(require.resolve('../public/app.js'), 'utf8'), context);
vm.runInContext('App.boot = () => {};', context);
vm.runInContext(fs.readFileSync(require.resolve('../public/plan.js'), 'utf8'), context);
context.row = first.current; context.plan = first.overlay.data.plan;
context.overlay = first.overlay.data.liveOverlay; context.alloc = first.advice.paydayAllocation;
const html = vm.runInContext('calendarWaterfallHtml(row, overlay, alloc, plan)', context);
assert.match(html, /From today · 2026-08-20/);
assert.match(html, /data-from-today="2026-08-20"/);
assert.match(html, /Proposed to set aside now<\/span><span>\$250\.00/);
assert.match(html, /Current chequing cash<\/span><span>\$800\.00/);
assert.match(html, /Remaining household needs<\/span><span>\$250\.00/);
assert.match(html, /data-from-today-period="2026-08-28"/);
assert.match(html, /no original funding snapshot/);
assert.match(html, /Shared savings and silver are not added/);
assert.match(html, /Actual saved and destination account: unknown/);
assert.equal((html.match(/data-operating-question=/g) || []).length, 6,
  'from-today proposal is outside the original payday arithmetic steps');
context.row = structuredClone(first.current);
context.row.fromTodayFunding.trust = 'estimated';
assert.match(vm.runInContext('calendarWaterfallHtml(row, overlay, alloc, plan)', context),
  /Proposed to set aside now<\/span><span>\$250\.00 ≈ estimated/);

const low = structuredClone(payload); low.accounts[0].balance = 100;
const short = refresh(low); context.row = short.current;
const shortHtml = vm.runInContext('calendarWaterfallHtml(row, overlay, alloc, plan)', context);
assert.match(shortHtml, /Proposals stop after the protected funding gap on 2026-08-20/);
assert.match(shortHtml, /2026-08-28 · Unavailable proposed/);
assert.doesNotMatch(shortHtml, /2026-08-28 · \$0\.00 proposed/);

// Review repairs go through the actual Budget entrypoint's recommend call,
// including its real live-evidence options. Stop after that expensive call,
// then execute the actual selected-period renderer with the returned advice.
// Only the surrounding DOM boot is held; no financial function is replaced.
(async () => {
async function budgetRefresh(canonical, source, extraOpts = {}) {
  const before = JSON.stringify({ canonical, source });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-from-today-review-'));
  let served;
  try {
    const fixturePath = path.join(dir, 'observation.json');
    const mapPath = path.join(dir, 'map.json');
    fs.writeFileSync(fixturePath, JSON.stringify(source));
    fs.writeFileSync(mapPath, JSON.stringify(map));
    // The actual server wrapper uses the same observation/overlay path and
    // production fail-closed fallback for an incomplete advancing refresh.
    served = await Live.applyForServer(canonical, { ATLAS_LIVE_OVERLAY: 'fixture',
      ATLAS_LIVE_OVERLAY_FIXTURE: fixturePath, ATLAS_LIVE_OVERLAY_MAP: mapPath });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const overlay = { data: served };
  let advice, passed;
  const stop = new Error('Budget recommend completed');
  context.served = served;
  context.Forecast = { ...F, recommend(plan, asOf, opts) {
    passed = opts;
    advice = F.recommend(plan, asOf, { ...opts, ...extraOpts });
    throw stop;
  } };
  vm.runInContext('Object.assign(state, served.plan.defaults, { debts: served.debts });', context);
  try { vm.runInContext('renderPlan(served, null, null)', context); }
  catch (error) { if (error !== stop) throw error; }
  finally { context.Forecast = F; }
  assert.ok(advice, 'real Budget entrypoint must call recommend');
  assert.equal(passed.observedCash, served.liveOverlay.observedCash,
    'real Budget must pass observed stock evidence, including incomplete packets');
  assert.equal(JSON.stringify({ canonical, source }), before);
  const current = advice.payPeriodViews.find(p => p.start <= served.meta.asOf && p.end >= served.meta.asOf);
  context.row = current; context.plan = served.plan;
  context.overlay = served.liveOverlay; context.alloc = advice.paydayAllocation;
  const html = vm.runInContext('calendarWaterfallHtml(row, overlay, alloc, plan)', context);
  return { overlay, advice, current, proposal: current.fromTodayFunding, html,
    todayHtml: html.split('<section class="calendar-waterfall"')[0] };
}
function reviewFixture() {
  const canonical = fixture();
  canonical.plan.cardPurchaseCoverage = require('./fixtures/card-coverage-opening')('2026-08-14');
  canonical.meta.asOf = canonical.plan.opening.asOf = '2026-08-13';
  canonical.plan.defaults.targetBuffer = 50;
  canonical.plan.startingCash.breakdown = structuredClone(data.plan.startingCash.breakdown);
  canonical.plan.startingCash.breakdown[0].value = 1000;
  canonical.plan.bills.push({ id: 'still-due', label: 'Still due', frequency: 'once',
    date: '2026-08-25', amount: 150, confidence: 'confirmed' });
  canonical.plan.obligations.push({ id: 'minimum', label: 'Required card payment',
    debtId: 'travelvisa', effect: 'payment', frequency: 'once', date: '2026-08-25',
    amount: 25, confidence: 'confirmed' });
  canonical.debts = structuredClone(data.debts);
  const source = structuredClone(payload);
  source.accounts[0].balance = 1000;
  return { canonical, source };
}
const control = reviewFixture();
const complete = await budgetRefresh(control.canonical, control.source);
assert.equal(complete.proposal.currentCash, 1000);
assert.equal(complete.proposal.operatingBills, 375);
assert.equal(complete.proposal.availableNow, 275);
assert.equal(complete.proposal.contribution, 250);
assert.equal(complete.proposal.periods[1].contribution, 350);
assert.deepEqual((await budgetRefresh(control.canonical, control.source)).proposal, complete.proposal);

// P1: supplied-dollar $750 - $375 - $250 - $50 buffer - $50 uncovered card = $25 through recommend
// and the real rendered instruction, with both modelled credit paths.
const poor = reviewFixture(); poor.source.accounts[0].balance = 750;
for (const date of [AS_OF, '2026-08-25']) {
  for (const field of ['plannedFlows', 'injections']) {
    const result = await budgetRefresh(poor.canonical, poor.source, {
      [field]: [{ date, amount: 1000, id: 'synthetic-loan', debtId: 'heloc' }],
    });
    assert.equal(result.proposal.status, 'funding-gap');
    assert.equal(result.proposal.operatingBills, 375);
    assert.equal(result.proposal.availableNow, 25);
    assert.equal(result.proposal.contribution, 25);
    assert.match(result.todayHtml, /Proposed to set aside now<\/span><span>\$25\.00/);
    assert.match(result.todayHtml, /2026-08-20.*225.00.*Named cost/);
    assert.doesNotMatch(result.todayHtml, /Proposed to set aside now<\/span><span>\$250\.00/);
  }
}

// P1: independently supplied carry: 1000 - 375 - 250 = 375;
// 375 + 1000 - 200 - 150 - 300 - 600 = 125;
// 125 + 1000 - 200 - 300 - 600 = 25 < the $50 floor.
// The allocator's later operating barrier must retract earlier actionable
// proposals, including the named-cost fully-funded appearance in Budget.
const carry = reviewFixture();
carry.canonical.plan.bills.push({ id: 'later-operations', label: 'Later operating bill',
  frequency: 'once', date: '2026-09-20', amount: 600, confidence: 'confirmed' });
const blocked = await budgetRefresh(carry.canonical, carry.source);
assert.equal(blocked.proposal.contribution, null);
assert.equal(blocked.proposal.items.find(r => r.id === 'named-cost').cumulativeProposed, null);
assert.match(blocked.todayHtml, /operating.*2026-09-24.*75.00.*100.00/i);
assert.doesNotMatch(blocked.todayHtml, /Cumulative proposed \/ cost|data-from-today-cost/,
  'a withheld proposal shows the reason, not a table of unavailable allocations');
assert.doesNotMatch(blocked.todayHtml, /Proposed to set aside now|\$250\.00|\$350\.00|data-from-today-period/);
carry.canonical.plan.bills.at(-1).amount = 525;
assert.equal((await budgetRefresh(carry.canonical, carry.source)).proposal.status, 'ready');
carry.canonical.plan.bills.at(-1).amount = 1000;
carry.source.accounts[0].balance = 750;
const blockedBeyondFirstGap = await budgetRefresh(carry.canonical, carry.source);
assert.equal(blockedBeyondFirstGap.proposal.contribution, null);
assert.match(blockedBeyondFirstGap.todayHtml, /operating.*2026-09-24/i);
assert.doesNotMatch(blockedBeyondFirstGap.todayHtml, /Proposed to set aside now|\$25\.00/);

// P1: either missing canonical stock and either missing provider stock must
// withhold same-date and date-advancing instructions. An actual observed zero
// is complete evidence; omission is not. Savings/silver cannot fill the hole.
for (const sameDate of [true, false]) {
  const known = reviewFixture();
  known.canonical.plan.startingCash.breakdown[1].value = known.source.accounts[1].balance = 1000;
  if (sameDate) {
    known.canonical.meta.asOf = known.canonical.plan.opening.asOf = AS_OF;
    known.canonical.plan.opening.priorAsOf = '2026-08-13';
  }
  const both = await budgetRefresh(known.canonical, known.source);
  assert.equal(both.proposal.currentCash, 2000, 'pool is A+B; savings/silver remain excluded');
  assert.equal(both.advice.paydayAllocation.currentBalancePublication.amount, 1000,
    'Current Balance remains the Bills account only');
  assert.equal(both.advice.paydayAllocation.currentBalancePublication.accountId, 'chequing-a');
  assert.equal(both.proposal.contribution, 250);
  for (const id of ['chequing-a', 'chequing-b']) {
    for (const missing of ['canonical', 'provider']) {
      const input = reviewFixture();
      input.canonical.plan.startingCash.breakdown[1].value = 1000;
      input.source.accounts[1].balance = 1000;
      if (sameDate) {
        input.canonical.meta.asOf = input.canonical.plan.opening.asOf = AS_OF;
        input.canonical.plan.opening.priorAsOf = '2026-08-13';
      }
      if (missing === 'canonical') input.canonical.plan.startingCash.breakdown =
        input.canonical.plan.startingCash.breakdown.filter(r => r.id !== id);
      else input.source.accounts = input.source.accounts.filter(r => r.id !== (id === 'chequing-a' ? 1001 : 1002));
      const result = await budgetRefresh(input.canonical, input.source);
      assert.equal(result.overlay.data.liveOverlay.observedCash.complete, false);
      assert.ok(!result.proposal || result.proposal.contribution === null, `${sameDate}/${id}/${missing}`);
      if (result.proposal) assert.equal(result.proposal.trust, 'unavailable');
      assert.doesNotMatch(result.todayHtml, /Proposed to set aside now|\$250\.00/);
      if (sameDate) assert.match(result.todayHtml, /data-savings-evidence-reason="cash-/);
      else assert.equal(result.advice.operatingPlanUnavailable, true, 'advancing failure preserves stale-plan barrier');
    }
  }
}
assert.equal(fs.readFileSync(require.resolve('../data.json'), 'utf8'), diskBefore);
console.log('PASS from-today integration: provider observation, read-only refresh, Forecast and real Budget rendering');
})().catch(error => { console.error(error); process.exitCode = 1; });
