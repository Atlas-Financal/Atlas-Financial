'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const F = require('../public/forecast');
const fixture = require('./fixtures/planned-savings-clarity-data');
const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
const ctx = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
  document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
  localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
ctx.window = ctx; ctx.matchMedia = () => ({ matches: false, addEventListener() {} });
for (const script of ['app', 'bill-detail', 'savings-inventory', 'budget-surface', 'plan']) {
  if (script === 'bill-detail') vm.runInContext('App.boot=()=>{};', ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/' + script + '.js'), 'utf8'), ctx);
}
for (const mode of ['ready', 'unconfirmed', 'gap', 'backed', 'pool-deficit', 'stale', 'backed-ready', 'range']) {
  const data = fixture(mode), original = JSON.stringify(data);
  const advice = F.recommend(data.plan, data.meta.asOf, {});
  const period = advice.payPeriodViews.find(p => p.timelineRole === 'current');
  const published = JSON.stringify(advice);
  ctx.probe = period; ctx.plan = data.plan;
  ctx.savings = { inventory: advice.savingsInventory, asOf: data.meta.asOf };
  const html = vm.runInContext('calendarWaterfallHtml(probe,null,null,plan,true,savings)', ctx);
  const section = html.split('data-budget-planned-savings-summary>')[1].split('</section>')[0];
  const glance = section.split('<details')[0];
  assert.match(section, /data-budget-savings-info><summary>Info<\/summary>/);
  assert.doesNotMatch(glance, /original payday|snapshot|attributable|Required this period:|Remaining this period:/);
  assert.doesNotMatch(glance, /\d{4}-\d{2}-\d{2}|data-budget-savings-contribution=/, 'no dates or period-fulfilled substitute for total stock');
  if (['ready', 'gap', 'unconfirmed', 'backed-ready'].includes(mode)) assert.match(html, /data-budget-goal-fulfillment-evidence="invented-cost-13"/, 'all obligations remain in evidence');
  if (period.plannedCostFunding.status === 'unavailable') {
    assert.match(glance, /Funding plan not confirmed/);
    assert.equal(period.plannedCostFunding.contribution, null);
    assert.match(glance, /data-budget-savings-proposed><span class="budget-v3-unknown">Unknown/, 'unknown period contributions are not filled from saved stock');
  }
  if (mode === 'unconfirmed') {
    assert.equal((glance.match(/data-budget-savings-total-goal=/g) || []).length, 4);
    assert.match(glance, /Invented classes/);
    assert.match(glance, /143\.00/);
    assert.match(glance, /data-budget-savings-total-saved><span class="budget-v3-unknown">Unknown/);
    assert.doesNotMatch(glance, /\$0\.00/);
  }
  if (['backed', 'pool-deficit', 'stale', 'range'].includes(mode)) {
    assert.equal((glance.match(/data-budget-savings-total-goal=/g) || []).length, 3, 'shared goal appears once');
    const trip = glance.split('data-budget-savings-total-goal="commitment:trip-a"')[1].split('</li>')[0];
    assert.match(trip, /403\.21/);
    if (['backed', 'range'].includes(mode)) assert.match(trip, /215\.04/, '16937 + 4567 independently backed cents across two pools');
    else assert.match(trip, /data-budget-savings-total-saved><span class="budget-v3-unknown">Unknown/, 'incomplete backing withholds whole goal');
    if (mode === 'range') assert.match(trip, /403\.21[\s\S]*500\.00/, 'both published range bounds stay visible');
  }
  if (mode === 'backed-ready') {
    assert.match(glance, /215\.04[\s\S]*600\.00[\s\S]*177\.96[\s\S]*This period/);
    assert.equal(Math.round(period.plannedCostFunding.contribution * 100), 60000 + 13 * 1100 - (16937 + 4567) - 35000,
      'existing pool stock is used once; period contribution funds only the remaining requirement');
    const summary = html.split('data-operating-question="savings"')[1].split('</summary>')[0];
    assert.match(summary, /500\.03/, 'observed account stock is 30001 + 20002 cents, independent of assignments and proposals');
    assert.doesNotMatch(summary, /177\.96|215\.04|600\.00/);
    const originalSavings = ctx.savings;
    for (const mutate of [
      s => { delete s.reportedStock; },
      s => { s.reportedStock.source = 'ignored-extra-field'; s.reportedStock.basis = 'projected'; },
      s => { s.reportedStock.status = 'unavailable'; },
      s => { s.reportedStock.asOf = '2026-08-13'; },
      s => { s.reportedStock.currency = 'USD'; },
      s => { s.reportedStock.trust = 'estimated'; },
      s => { s.reportedStock.evidenceTrust = 'unknown'; },
      s => { s.reportedStock.nonAdditive = false; },
      s => { s.reportedStock.amount = '500.03'; },
      s => { s.reportedStock.amount = NaN; },
      s => { s.reportedStock.accountIds = {}; },
      s => { s.reportedStock.accountIds = ['savings', 'savings']; },
      s => { s.reportedStock.accountIds = ['savings']; },
      s => { s.reportedStock.accountIds = ['savings', 'unrelated-account']; },
      s => { delete s.reportedStock.balanceFrom; },
      s => { s.reportedStock.balanceThrough = '2027-01-01'; },
      s => { s.reportedStock.balanceFrom = '2026-02-30'; },
      s => { s.reportedStock.balanceDates = null; },
      s => { s.reportedStock.balanceDates[0].accountId = 'unrelated-account'; },
      s => { s.reportedStock.balanceDates[0].date = '2027-01-01'; },
      s => { s.pools[1].accountId = s.pools[0].accountId; },
    ]) {
      const inventory = structuredClone(originalSavings.inventory); mutate(inventory);
      ctx.savings = { ...originalSavings, inventory };
      const withheld = vm.runInContext('calendarWaterfallHtml(probe,null,null,plan,true,savings)', ctx);
      assert.match(withheld.split('data-operating-question="savings"')[1].split('</summary>')[0], /Unavailable/,
        'invalid stock cannot fall back to proposals, assignments or partial pool balances');
      assert.match(withheld.split('data-operating-question="07"')[1].split('</summary>')[0], /322\.04/,
        'stock withholding never changes the incumbent final result');
    }
    ctx.savings = originalSavings;
    ctx.probe = { ...period, operatingPlanUnavailable: true };
    assert.match(vm.runInContext('calendarWaterfallHtml(probe,null,null,plan,true,savings)', ctx)
      .split('data-operating-question="savings"')[1].split('</summary>')[0], /500\.03/,
    'verified observed reserve stock does not depend on operating plan availability');
    ctx.probe = period;
    for (const mutate of [
      p => { p.plannedCostFunding.source = 'Unrelated calculator'; },
      p => { p.plannedCostFunding.basis = 'unrelated-period'; },
      p => { p.plannedCostFunding.asOf = '2026-08-13'; },
      p => { p.budgetProgress.currency = 'USD'; },
      p => { delete p.budgetProgress; },
      p => { delete p.budgetProgress; delete p.plannedCostFunding.asOf; },
    ]) {
      const mismatched = JSON.parse(JSON.stringify(period));
      mutate(mismatched); ctx.probe = mismatched;
      const before = JSON.stringify(mismatched);
      const withheld = vm.runInContext('calendarWaterfallHtml(probe,null,null,plan,true,savings)', ctx);
      assert.match(withheld.split('data-operating-question="savings"')[1].split('</summary>')[0], /500\.03/,
        'valid observed stock is independent of withheld period proposals');
      const compact = withheld.split('data-budget-planned-savings-summary>')[1].split('<details')[0];
      assert.match(compact, /Funding plan not confirmed/);
      assert.match(compact, /data-budget-savings-proposed><span class="budget-v3-unknown">Unknown/);
      assert.equal(JSON.stringify(mismatched), before, 'withholding does not alter the financial publication');
    }
    ctx.probe = period;
  }
  if (mode === 'ready') assert.equal(period.plannedCostFunding.contribution, 600 + 13 * 11 - 350);
  if (mode === 'gap') assert.match(glance, /Funding shortfall:/, 'material gap stays visible without opening Info');
  const inventory = ctx.savings.inventory;
  assert.ok(html.indexOf('data-operating-question="07"') < html.indexOf('data-operating-question="savings"'), 'stock follows the final result');
  const stockRow = html.split('data-operating-question="savings"')[1].split('</summary>')[0];
  assert.doesNotMatch(stockRow, /budget-waterfall-track|budget-progress-track|budget-waterfall-bar/);
  assert.match(stockRow, /operating-number" aria-hidden="true">\u2022<\/span>/, 'stock has no deduction sign');
  ctx.savings = { inventory, asOf: '2026-08-21' };
  assert.doesNotMatch(vm.runInContext('calendarWaterfallHtml(probe,null,null,plan,true,savings)', ctx), /data-budget-savings-total-goal=/, 'a mismatched inventory cannot supply total stock');
  assert.equal(JSON.stringify(data), original);
  assert.equal(JSON.stringify(advice), published, 'renderer does not alter any financial publication');
}
for (const mode of ['projection', 'projection-remaining', 'projection-undated', 'projection-missing-cash', 'projection-stale']) {
  const data = fixture(mode), original = JSON.stringify(data);
  const advice = F.recommend(data.plan, data.meta.asOf, {});
  const timeline = F.savingsFundingTimeline(data.plan, [], data.meta.asOf, { weeklyVariable: 35 });
  const current = advice.payPeriodViews.find(row => row.timelineRole === 'current');
  const render = (period = current, packet = timeline, inventory = advice.savingsInventory) => {
    ctx.probe = period; ctx.plan = data.plan;
    ctx.savings = { inventory, timeline: packet, asOf: data.meta.asOf };
    return vm.runInContext('calendarWaterfallHtml(probe,null,null,plan,true,savings)', ctx);
  };
  const publication = JSON.stringify({ advice, timeline });
  const html = render(), section = html.split('data-budget-planned-savings-summary>')[1].split('<details')[0];
  assert.equal((section.match(/data-budget-savings-total-goal=/g) || []).length, 3);
  assert.equal((section.match(/data-budget-savings-total-saved><span class="budget-v3-unknown">Unknown/g) || []).length, 3,
    'observed pool cash and projected location never become saved goal assignments');
  assert.match(section, /Funding plan not confirmed/);
  assert.match(html.split('data-operating-question="savings"')[1].split('</summary>')[0], /80\.00/,
    'observed stock is independent of hypothetical contributions and operating cash availability');
  if (mode === 'projection-stale') assert.match(html, /Observed 2026-09-09 – 2026-09-10/,
    'stale valid balances disclose their source dates without restoring the projection');
  if (['projection', 'projection-remaining'].includes(mode)) {
    assert.doesNotMatch(section.replace(/<[^>]*>/g, ''), /projected|projection/i);
    assert.match(html, /Hypothetical projection/);
    assert.match(html, /Actual contributions unknown/);
    const camp = section.split('data-budget-savings-total-goal="group:camp-a"')[1].split('</li>')[0];
    const annual = section.split('data-budget-savings-total-goal="yearly-bill:annual-a"')[1].split('</li>')[0];
    assert.match(camp, /280\.00/, 'two invented dated needs, 80 + 200, grouped by Forecast once');
    assert.match(camp, mode === 'projection' ? /230\.00/ : /0\.00/,
      'independent dated ledger: 280 camp need less 50 stock; remaining fixture has zero capacity');
    assert.match(annual, mode === 'projection' ? /40\.00/ : /0\.00/, '70 need less 30 observed pool is a 40 hypothetical contribution');
    const undated = section.split('data-budget-savings-total-goal="commitment:undated-a"')[1].split('</li>')[0];
    assert.match(undated, mode === 'projection' ? /40\.00/ : /0\.00/,
      'the separate invented December need is a dated numeric control');
    assert.match(section, mode === 'projection' ? /This period/ : /Remaining this period/);
    if (mode === 'projection-remaining') {
      assert.match(section, /data-budget-savings-projection-gap/);
      assert.match(html, /data-budget-savings-projection-gap-detail/);
    }
    assert.doesNotMatch(render({ ...current, operatingPlanUnavailable: true }), /data-budget-savings-projection/);
    assert.doesNotMatch(render({ ...current, timelineRole: 'past', lookback: true }), /data-budget-savings-projection/);
    const staleInventory = structuredClone(advice.savingsInventory);
    staleInventory.pools[0].observedTrust = 'unknown';
    assert.doesNotMatch(render(current, timeline, staleInventory), /data-budget-savings-projection/);
    const next = advice.payPeriodViews.find(row => row.timelineRole === 'next');
    const nextHtml = render(next);
    assert.match(nextHtml, /This period/);
    assert.doesNotMatch(nextHtml.split('data-budget-planned-savings-summary>')[1].split('<details')[0], /Remaining this period/);
    const past = advice.payPeriodViews.find(row => row.timelineRole === 'past');
    assert.doesNotMatch(render(past), /data-budget-savings-projection/);
    for (const mutate of [
      p => { p.source = 'Other'; }, p => { p.asOf = '2026-09-09'; }, p => { p.currency = 'USD'; },
      p => { p.status = 'unavailable'; }, p => { p.trust = 'calculated'; },
      p => { p.nature = 'confirmed'; }, p => { p.actionPermission = 'granted'; },
      p => { p.incrementalInstructions = 'ready'; }, p => { p.actualContributions = 0; },
      p => { p.payPeriods[0].cycleEnd = '2026-09-24'; }, p => { p.payPeriods[0].end = '2026-09-22'; },
      p => { p.payPeriods[0].windowKind = 'unsupported'; },
      p => { p.payPeriods.push(p.payPeriods[0]); },
    ]) {
      const changed = JSON.parse(JSON.stringify(timeline)); mutate(changed);
      assert.doesNotMatch(render(current, changed), /data-budget-savings-projection/, 'mismatched source, trust, permission or window withheld');
    }
    for (const mutate of [
      g => { g.actualSaved = 0; }, g => { g.actualContribution = 0; }, g => { g.trust = 'calculated'; },
      g => { g.projectedContribution = '270'; }, g => { g.projectedContribution = NaN; },
    ]) {
      const changed = structuredClone(timeline); mutate(changed.payPeriods[0].goals[0]);
      const row = render(current, changed).split('data-budget-savings-total-goal="group:camp-a"')[1].split('</li>')[0];
      assert.match(row, /data-budget-savings-projection><span class="budget-v3-unknown">Unknown/);
    }
  } else assert.doesNotMatch(html, /data-budget-savings-projection/, 'unknown cash and stale evidence do not supply a projection');
  assert.equal(JSON.stringify({ advice, timeline }), publication);
  assert.equal(JSON.stringify(data), original);
}
// Same-date reserve refresh must read current evidence rather than an older Month cache.
// Pending movement qualifies dated stock, including the actual next-period
// renderer. It never hides independently known stock or grants funding.
for (const pending of [false, true]) for (const dates of ['current', 'older', 'mixed']) {
  const data = fixture(pending ? 'stock-pending' : 'backed-ready');
  if (dates !== 'current') data.plan.savingsPoolObservation.accounts[0].evidenceDate = '2026-08-13';
  if (dates === 'older') data.plan.savingsPoolObservation.accounts[1].evidenceDate = '2026-08-13';
  const immutable = JSON.stringify(data), advice = F.recommend(data.plan, data.meta.asOf, {});
  const publication = JSON.stringify(advice);
  ctx.plan = data.plan; ctx.savings = { inventory: advice.savingsInventory, asOf: data.meta.asOf };
  for (const role of ['current', 'next']) {
    ctx.probe = advice.payPeriodViews.find(row => row.timelineRole === role);
    assert.ok(ctx.probe, 'use the real ' + role + ' period');
    const html = vm.runInContext('calendarWaterfallHtml(probe,null,null,plan,true,savings)', ctx);
    const note = html.match(/data-budget-savings-stock-evidence>([^<]*)<\/p>/)[1];
    assert.equal(note.includes('Pending movement evidence is unresolved; item backing remains separately qualified.'), pending);
    assert.match(html.split('data-operating-question="savings"')[1].split('</summary>')[0], /500\.03/,
      '300.01 + 200.02 dated stock survives pending evidence and future selection');
    assert.match(note, dates === 'current' ? /Observed 2026-08-14/ : dates === 'older'
      ? /Observed 2026-08-13\. / : /Observed 2026-08-13 [-\u2013] 2026-08-14/);
    assert.equal(JSON.stringify(advice), publication); assert.equal(JSON.stringify(data), immutable);
  }
}
const refreshed = fixture('projection');
ctx.source = { plan: refreshed.plan, debts: [], asOf: refreshed.meta.asOf, weekly: 35, weeklyOverride: 35,
  advice: F.recommend(refreshed.plan, refreshed.meta.asOf, {}), revolvingExtra: [] };
assert.equal(vm.runInContext('budgetSavingsTimelineFor(source).status', ctx), 'ready');
delete ctx.source.plan.startingCash.breakdown[0].value;
assert.equal(vm.runInContext('budgetSavingsTimelineFor(source).status', ctx), 'unavailable');
console.log('PASS Planned Savings: independent grouped projection amounts, remaining/future/historical windows, unknown actuals, strict packet boundaries, same-date evidence refresh, incumbent deduction and immutable outputs');
