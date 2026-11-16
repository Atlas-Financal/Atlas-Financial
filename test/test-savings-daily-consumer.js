'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const F = require('../public/forecast'), fixture = require('./fixtures/savings-daily-consumer-data');
const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
const ctx = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {}, document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } }, localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
ctx.window = ctx; ctx.matchMedia = () => ({ matches: false, addEventListener() {} });
for (const script of ['app', 'bill-detail', 'savings-inventory', 'budget-surface', 'plan']) {
  if (script === 'bill-detail') vm.runInContext('App.boot=()=>{};', ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/' + script + '.js'), 'utf8'), ctx);
}
vm.runInContext('state.targetBuffer=20;state.extraDebtMonthly=0;state.debts=[];', ctx);
for (const mode of ['ready', 'partial', 'full', 'multiple', 'returned', 'pending', 'unmatched', 'missing-stock', 'missing-cash', 'fully-backed', 'before-policy', 'saved-income', 'ranged-need']) {
  const data = fixture(mode), before = JSON.stringify(data);
  const advice = F.recommend(data.plan, data.meta.asOf, { weeklyVariable: 40, ...data.liveOverlay });
  ctx.src = { plan: data.plan, debts: [], asOf: data.meta.asOf, advice, liveOverlay: data.liveOverlay, weekly: 40, weeklyOverride: 40 };
  const packet = vm.runInContext('budgetDailySavingsFor(src)', ctx);
  const expected = { ready: 80, partial: 50, full: 0, multiple: 30, returned: 0, 'fully-backed': 0, 'saved-income': 80 }[mode];
  assert.equal(packet.period.proposal, expected ?? null);
  assert.deepEqual(vm.runInContext('budgetDailySavingsFor(src)', ctx), packet, 'replace-only refresh');
  ctx.period = advice.payPeriodViews.find(p => p.timelineRole === 'current'); ctx.packet = packet;
  const html = vm.runInContext('calendarWaterfallHtml(period,src.liveOverlay,null,src.plan,true,{daily:packet,inventory:src.advice.savingsInventory,asOf:src.asOf})', ctx);
  assert.match(html, /data-budget-daily-savings/);
  assert.ok(html.indexOf('data-operating-question="07"') < html.indexOf('data-operating-question="savings"'));
  const proposal = html.split('data-budget-daily-proposal>')[1].split('</strong>')[0];
  if (expected == null) assert.match(proposal, /Unavailable/); else assert.match(proposal, new RegExp(expected.toFixed(2).replace('.', '\\.')));
  assert.match(html, /Earlier planning calculation &amp; obligation evidence/);
  assert.doesNotMatch(html, /data-operating-question="reserve-use"/);
  const upcoming = vm.runInContext('budgetUpcomingFundingHtml(src)', ctx);
  const today = upcoming.split('data-budget-funding-panel="today"')[1].split('data-budget-funding-panel="payday"')[0];
  if (expected == null) assert.match(today.split('data-budget-funding-proposal>')[1].split('</strong>')[0], /Unavailable/);
  else assert.match(today.split('data-budget-funding-proposal>')[1].split('</strong>')[0], new RegExp(expected.toFixed(2).replace('.', '\\.')));
  if (mode === 'partial') { assert.equal(packet.stock.amount, 149); assert.equal(packet.rows[0].saved, 125); assert.equal(packet.period.transferred, 30); }
  if (mode === 'saved-income') { assert.equal(packet.period.nativePeriodSurplus, 160); assert.equal(packet.period.entitlement, 80); assert.equal(ctx.period.afterHouseholdBudget, 160); }
  if (mode === 'missing-cash') assert.equal(packet.stock.amount, 119, 'cash uncertainty cannot erase observed stock');
  if (mode === 'before-policy') assert.match(html.split('data-operating-question="savings"')[1].split('</summary>')[0], /119\.00/, 'policy uncertainty cannot erase observed stock');
  if (mode === 'fully-backed') {
    assert.equal(packet.period.unassigned, 80);
    assert.match(html, /Unassigned capacity[\s\S]*80\.00/);
    assert.doesNotMatch(html, /Unassigned top-up/);
  }
  if (mode === 'ranged-need') {
    assert.equal(packet.status, 'unavailable');
    const home = packet.rows.find(row => row.key === 'yearly-bill:home-cost');
    assert.equal(home.needed, 24, 'independent exact home requirement');
    assert.equal(home.trust, 'calculated');
    assert.equal(home.neededTrust, 'calculated', 'unavailable backing retains independent exact requirement trust');
    ctx.knownNeed = home;
    assert.match(vm.runInContext('budgetDailyNeededHtml(knownNeed)', ctx), /24\.00/);
    const homeHtml = html.split('data-budget-savings-total-goal="yearly-bill:home-cost"')[1].split('</li>')[0];
    assert.match(homeHtml.split('data-budget-savings-total-needed>')[1], /24\.00/);
    assert.match(homeHtml.split('data-budget-savings-total-saved>')[1].split('</span>')[0], /Unavailable/);
    assert.match(homeHtml.split('data-budget-savings-proposed>')[1].split('</span>')[0], /Unavailable/);
    assert.match(vm.runInContext('budgetSavingsGoalsHtml(src,period,null)', ctx), /24\.00/);
  }
  assert.equal(JSON.stringify(data), before, 'canonical fixture not mutated');
}

for (const row of [
  { needed: null, trust: 'calculated' }, { needed: '24', trust: 'calculated' },
  { needed: 24, trust: 'unknown' }, { needed: 24, neededTrust: 'unknown', trust: 'calculated' },
]) {
  ctx.knownNeed = row;
  assert.match(vm.runInContext('budgetDailyNeededHtml(knownNeed)', ctx), /Unavailable/, 'no coercion or override of explicit unknown requirement trust');
}

delete ctx.src.advice.savingsFunding;
ctx.packet = vm.runInContext('budgetDailySavingsFor(src)', ctx);
assert.equal(ctx.packet.stock, undefined, 'failed daily publication does not invent stock');
const failed = vm.runInContext('calendarWaterfallHtml(period,src.liveOverlay,null,src.plan,true,{daily:packet,inventory:src.advice.savingsInventory,asOf:src.asOf})', ctx);
assert.match(failed, /data-budget-daily-savings/);
assert.match(failed.split('data-budget-daily-proposal>')[1].split('</strong>')[0], /Unavailable/);
const failedStockCents = ctx.src.plan.savingsPoolObservation.accounts
  .reduce((sum, row) => sum + Math.round(row.value * 100), 0);
assert.match(failed.split('data-operating-question="savings"')[1].split('</summary>')[0],
  new RegExp((failedStockCents / 100).toFixed(2).replace('.', '\\.')),
  'daily publication failure cannot erase independently observed inventory stock');
assert.doesNotMatch(failed, /data-operating-question="reserve-use"/);
ctx.Forecast = F;
const readyData = fixture('ready');
ctx.src = { plan: readyData.plan, debts: [], asOf: readyData.meta.asOf,
  advice: F.recommend(readyData.plan, readyData.meta.asOf, { weeklyVariable: 40, ...readyData.liveOverlay }),
  liveOverlay: readyData.liveOverlay, weekly: 40, weeklyOverride: 40 };
const valid = vm.runInContext('budgetDailySavingsFor(src)', ctx);
ctx.period = ctx.src.advice.payPeriodViews.find(p => p.timelineRole === 'current');
const rejectedStockCents = ctx.src.plan.savingsPoolObservation.accounts
  .reduce((sum, row) => sum + Math.round(row.value * 100), 0);
const rejectedStockRe = new RegExp((rejectedStockCents / 100).toFixed(2).replace('.', '\\.'));
for (const mutate of [p => { p.source = 'other'; }, p => { p.asOf = '2026-10-06'; }, p => { p.currency = 'USD'; }, p => { p.period.basis = 'after-proposals'; }, p => { p.period.start = '2026-10-16'; }, p => { p.moneyMovementPermission = 'granted'; }, p => { p.period.allocations = null; }, p => { p.period.allocations[0].amount = null; }, p => { p.period.cycleAllocations[0].amount = '80'; }]) {
  const invalid = JSON.parse(JSON.stringify(valid)); mutate(invalid);
  ctx.src.advice.savingsFunding = invalid;
  ctx.packet = vm.runInContext('budgetDailySavingsFor(src)', ctx);
  assert.equal(ctx.packet.status, 'unavailable', 'invalid scope or authority never borrows legacy amounts');
  assert.equal(ctx.packet.stock, undefined, 'rejected daily packet does not invent stock');
  const withheld = vm.runInContext('calendarWaterfallHtml(period,src.liveOverlay,null,src.plan,true,{daily:packet,inventory:src.advice.savingsInventory,asOf:src.asOf})', ctx);
  assert.match(withheld.split('data-budget-daily-proposal>')[1].split('</strong>')[0], /Unavailable/);
  assert.match(withheld.split('data-operating-question="savings"')[1].split('</summary>')[0], rejectedStockRe,
    'rejected daily packet cannot erase independently observed inventory stock');
}
// A publication failure may preserve current verified stock, never stale or
// invalid inventory. These are independent inputs, not derived expected totals.
for (const failure of ['exception', 'currency', 'allocation']) {
  const rejected = JSON.parse(JSON.stringify(valid));
  if (failure === 'currency') rejected.currency = 'USD';
  if (failure === 'allocation') rejected.period.allocations[0].amount = null;
  ctx.src.advice.savingsFunding = failure === 'exception' ? undefined : rejected;
  ctx.packet = vm.runInContext('budgetDailySavingsFor(src)', ctx);
  assert.equal(ctx.packet.source, 'Budget.savingsDailyFundingUnavailable');
  for (const [label, mutate] of [
    ['verified current stock', () => {}],
    ['stale inventory', i => { i.asOf = '2026-10-04'; }],
    ['stale stock', i => { i.reportedStock.asOf = '2026-10-04'; }],
    ['foreign inventory currency', i => { i.currency = 'USD'; }],
    ['foreign stock currency', i => { i.reportedStock.currency = 'USD'; }],
    ['wrong inventory source', i => { i.source = 'other'; }],
    ['additive inventory', i => { i.nonAdditive = false; }],
    ['unknown stock evidence', i => { i.reportedStock.evidenceTrust = 'unknown'; }],
    ['nonnumeric stock', i => { i.reportedStock.amount = '119'; }],
    ['duplicate accounts', i => { i.reportedStock.accountIds = ['savings', 'savings']; }],
    ['missing pool', i => { i.pools.pop(); }],
  ]) {
    ctx.inventory = JSON.parse(JSON.stringify(ctx.src.advice.savingsInventory)); mutate(ctx.inventory);
    const html = vm.runInContext('calendarWaterfallHtml(period,src.liveOverlay,null,src.plan,true,{daily:packet,inventory,asOf:src.asOf})', ctx);
    assert.match(html.split('data-operating-question="savings"')[1].split('</summary>')[0],
      label === 'verified current stock' ? /119\.00/ : /Unavailable/, failure + ': ' + label);
    assert.match(html.split('data-budget-daily-proposal>')[1].split('</strong>')[0], /Unavailable/);
  }
  const today = vm.runInContext('budgetUpcomingFundingHtml(src)', ctx).split('data-budget-funding-panel="today"')[1].split('data-budget-funding-panel="payday"')[0];
  assert.match(today.split('data-budget-funding-proposal>')[1].split('</strong>')[0], /Unavailable/);
}
const nativeUnavailable = JSON.parse(JSON.stringify(valid));
nativeUnavailable.status = nativeUnavailable.period.status = 'unavailable';
nativeUnavailable.period.proposal = null;
Object.assign(nativeUnavailable.stock, { status: 'unavailable', amount: null, trust: 'unknown', evidenceTrust: 'unknown' });
ctx.src.advice.savingsFunding = nativeUnavailable;
ctx.packet = vm.runInContext('budgetDailySavingsFor(src)', ctx);
assert.equal(ctx.packet.source, 'Forecast.savingsDailyFunding', 'accepted native stock uncertainty retains its authority');
const nativeHtml = vm.runInContext('calendarWaterfallHtml(period,src.liveOverlay,null,src.plan,true,{daily:packet,inventory:src.advice.savingsInventory,asOf:src.asOf})', ctx);
assert.match(nativeHtml.split('data-operating-question="savings"')[1].split('</summary>')[0], /119\.00/, 'independently reported stock survives unavailable daily backing');
assert.match(nativeHtml.split('data-budget-daily-proposal>')[1].split('</strong>')[0], /Unavailable/);
console.log('PASS active current Budget/Savings consumer: thirteen independent ledgers, replace-only refresh, transfer once, native surplus vs entitlement, independently known requirement, publication boundary and guarded stock fallback');


// A missing selected-period child cannot substitute the current 119 stock.
ctx.src.advice=F.recommend(readyData.plan,readyData.meta.asOf,{weeklyVariable:40,...readyData.liveOverlay});
const future=ctx.src.advice.savingsFunding.periodViews.find(row=>row.role==='next');
assert.ok(future?.packet);delete future.packet;ctx.futureId=future.id;
const missingFuture=vm.runInContext('budgetDailySavingsFor(src,futureId)',ctx);
assert.equal(missingFuture.status,'unavailable');assert.equal(missingFuture.stock,undefined);
assert.equal(missingFuture.period.proposal,null,'no current offer is borrowed into a missing future publication');

// The live disclosure consumes real Forecast publications over synthetic inputs.
const costFact = (html, name) => html.split(`data-savings-cost-${name}>`)[1]?.split('</dd>')[0];
const evidence = (cents, reversals = []) => ({ commitments: cents == null ? [] : [{ goalId: 'commitment:near',
  links: [{ effectiveDate: '2026-10-03', assignedCents: cents, reversals }] }] });
function costWorld(settlementEvidence, mutate = () => {}) {
  const fx = require('./fixtures/savings-daily-allocation-contract');
  const x = require('./fixtures/chronological-savings-data').policy(fx.advance(fx.fixture(), '2026-10-07'));
  x.plan.commitments = x.plan.commitments.filter(row => row.id === 'near');
  mutate(x.plan.commitments[0]);
  const advice = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [], settlementEvidence });
  ctx.src = { plan: x.plan, debts: [], asOf: x.asOf, advice };
  ctx.costPacket = vm.runInContext('budgetDailySavingsFor(src)', ctx);
  return vm.runInContext('budgetDailySavingsHtml(costPacket)', ctx);
}
for (const [ev, original, paid, unpaid] of [
  [evidence(2500), /60\.00/, /25\.00/, /35\.00/],
  [evidence(6000), /60\.00/, /60\.00/, /0\.00/],
  [evidence(null), /60\.00/, /0\.00/, /60\.00/],
  [undefined, /60\.00/, /Unknown/, /Unknown/],
  [evidence(7000), /60\.00/, /Unknown/, /Unknown/],
  [evidence(2500, [{}]), /60\.00/, /Unknown/, /Unknown/],
]) {
  const html = costWorld(ev);
  // The yearly home-cost row has no commitment facts; first breakdown is near.
  assert.match(costFact(html, 'original'), original);
  assert.match(costFact(html, 'paid'), paid);
  assert.match(costFact(html, 'unpaid'), unpaid);
  assert.match(html, /Cost facts as of 2026-10-07/);
}
for (const ev of [evidence(null), evidence(2500)]) {
  const html = costWorld(ev, row => { delete row.amount; row.amountMin = 50.01; row.amountMax = 70.03; });
  assert.match(costFact(html, 'original'), /50\.01.*70\.03/);
  assert.match(costFact(html, 'paid'), ev.commitments.length ? /Unknown/ : /0\.00/);
  assert.match(costFact(html, 'unpaid'), ev.commitments.length ? /Unknown/ : /50\.01.*70\.03/);
}
// Malformed facts withhold independently; no need/saved fallback or coercion.
costWorld(evidence(2500));
const baseCostPacket = ctx.costPacket;
for (const [name, malformed] of [
  ['paid', { status: 'known', amount: '25', range: null }],
  ['paid', { status: 'known', amount: -1, range: null }],
  ['paid', { status: 'known', amount: Infinity, range: null }],
  ['unpaid', { status: 'known', amount: null, range: { min: 70, max: 50 } }],
  ['unpaid', { status: 'known', amount: 35, range: { min: 30, max: 40 } }],
  ['unpaid', null],
]) {
  ctx.costPacket = structuredClone(baseCostPacket);
  const row = ctx.costPacket.rows.find(row => row.commitmentCost);
  row.commitmentCost[name === 'paid' ? 'confirmedLinkedPaid' : 'unpaidCost'] = malformed;
  const html = vm.runInContext('budgetDailySavingsHtml(costPacket)', ctx);
  assert.match(costFact(html, name), /Unknown/);
  assert.match(costFact(html, 'original'), /60\.00/);
  assert.match(costFact(html, name === 'paid' ? 'unpaid' : 'paid'), name === 'paid' ? /35\.00/ : /25\.00/);
}
for (const date of [undefined, '2026-02-30', 'not a date']) {
  ctx.costPacket = structuredClone(baseCostPacket);
  const row = ctx.costPacket.rows.find(row => row.commitmentCost);
  row.commitmentCost.asOf = date;
  const html = vm.runInContext('budgetDailySavingsHtml(costPacket)', ctx);
  for (const field of ['original', 'paid', 'unpaid']) assert.match(costFact(html, field), /Unknown/);
  assert.match(costFact(html, 'saved'), /35\.00/, 'invalid cost date cannot erase independently valid saved');
}
{
  ctx.costPacket = structuredClone(baseCostPacket);
  const row = ctx.costPacket.rows.find(row => row.commitmentCost);
  row.commitmentCost.originalCost.amount = 0;
  assert.match(costFact(vm.runInContext('budgetDailySavingsHtml(costPacket)', ctx), 'original'), /0\.00/, 'genuine original zero is known');
  delete row.commitmentCost;
  const missing = vm.runInContext('budgetDailySavingsHtml(costPacket)', ctx);
  assert.match(costFact(missing, 'original'), /Unknown/, 'missing packet never falls back to needed');
  assert.match(costFact(missing, 'saved'), /35\.00/);
}
// Same renderer instance, current -> future -> current. Future opening facts
// belong only to Forecast's surviving roster and carry the actual opening date.
{
  const x = require('./fixtures/savings-selected-roster-data')();
  const ev = { commitments: [{ goalId: 'commitment:next', links: [{ effectiveDate: '2026-10-03', assignedCents: 1000, reversals: [] }] }] };
  const advice = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [], settlementEvidence: ev });
  ctx.src = { plan: x.plan, debts: [], asOf: x.asOf, advice };
  ctx.selectedCostPeriod = null;
  const render = () => vm.runInContext('budgetDailySavingsHtml(budgetDailySavingsFor(src,selectedCostPeriod))', ctx);
  const current = render();
  ctx.selectedCostPeriod = advice.payPeriodViews.find(p => p.start === '2026-10-16').id;
  const futureHtml = render();
  const opening = futureHtml.split('data-savings-opening-costs>')[1];
  assert.ok(opening, 'surviving opening facts are disclosed separately');
  assert.match(opening, /Cost facts as of 2026-10-07/);
  assert.match(costFact(opening, 'original'), /40\.00/);
  assert.match(costFact(opening, 'paid'), /10\.00/);
  assert.match(costFact(opening, 'unpaid'), /30\.00/);
  assert.doesNotMatch(opening, /Invented early installment|Invented boundary installment/);
  const closing = futureHtml.split('data-savings-opening-costs>')[0];
  assert.doesNotMatch(closing, /Cost facts as of/);
  ctx.selectedCostPeriod = null;
  assert.equal(render(), current, 'returning current replaces future facts exactly');
}
console.log('PASS Savings cost disclosure: native partial/full/empty/unconfigured/uncertain/range publications, independent fail-closed fields and period replacement');
