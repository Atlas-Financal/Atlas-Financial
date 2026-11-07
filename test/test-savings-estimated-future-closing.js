'use strict';
// PA-1 (Decision 1, owner 2026-10-29): when a Savings movement cannot be
// uniquely qualified, future periods publish Savings at period close and
// per-goal Saved tagged ESTIMATED with the reason named, instead of
// withholding. Verified backing and current-period figures are unchanged.
// All ledgers and literal expected cents are independently invented.
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const F = require(path.join(process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..'), 'public/forecast'));
const input = require('./fixtures/savings-future-closing-data');

const MOVEMENT_REASON = 'A savings movement lacks unique, qualified posted evidence.';
const FUTURE = ['2026-10-16', '2026-10-30', '2026-11-13', '2026-11-27', '2026-12-11'];

function scenario(unqualified) {
  const x = input();
  x.plan.income.push({ id: 'p0', label: 'Invented current receipt', frequency: 'once',
    date: '2026-10-09', amount: 400, confidence: 'confirmed' });
  if (unqualified) x.opts.currentPeriodActuals.savingsMovementUnconfirmed =
    [{ accountId: 'savings', reason: 'transaction-posting-status-unconfirmed' }];
  return x;
}
function advice(x) {
  const before = JSON.stringify(x);
  const result = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [] });
  assert.equal(JSON.stringify(x), before, 'no input, settlement or source mutation');
  return result;
}
function closing(a, start) {
  const view = a.savingsFunding.periodViews.find(p => p.start === start);
  assert.ok(view, `selected native period ${start} exists`);
  const p = F.savingsFundingPublication(a.savingsFunding, { asOf: a.savingsFunding.asOf, advice: a, periodId: view.id });
  assert.ok(p, `publication for ${start} is not nulled by the closing shape`);
  assert.ok(p.forecastClosing, 'Forecast owns the selected-period closing projection');
  return p.forecastClosing;
}
const stocks = a => FUTURE.map(start => closing(a, start).stock);

test('clean case is unchanged: verified closings, openings and sweeps', () => {
  const a = advice(scenario(false));
  assert.equal(a.savingsFunding.backing.status, 'ready');
  assert.deepEqual(stocks(a), [519, 1599, 2599, 2599, 1099]);
  for (const start of FUTURE) {
    const c = closing(a, start);
    assert.equal(c.status, 'ready', c.reason);
    // A future close is always a projection (trust estimated); the qualified
    // walk keeps its own nature and is never relabelled as the fallback.
    assert.equal(c.nature, 'if-eligible-surplus-saved');
    assert.equal(c.verifiedReason ?? null, null);
  }
  const views = a.payPeriodViews.filter(p => FUTURE.includes(p.start));
  assert.deepEqual(views.map(v => v.paydaySweep), [1080, 1000, 0, 0, 0]);
});

test('one unqualified movement: future closings publish tagged estimated with the reason', () => {
  const a = advice(scenario(true));
  // Verified backing stays withheld with the same reason; nothing is promoted.
  assert.equal(a.savingsFunding.backing.status, 'unavailable');
  assert.ok(a.savingsFunding.backing.reason.startsWith(MOVEMENT_REASON), a.savingsFunding.backing.reason);
  for (const start of FUTURE) {
    const c = closing(a, start);
    assert.equal(c.status, 'ready', `${start}: ${c.reason}`);
    assert.equal(c.trust, 'estimated', `${start} is tagged estimated`);
    assert.equal(c.nature, 'reported-balance-estimate');
    assert.ok(Number.isFinite(c.stock), `${start} publishes a Savings at period close`);
    assert.ok(String(c.verifiedReason || '').startsWith(MOVEMENT_REASON), 'the withholding reason is named');
    assert.ok(Array.isArray(c.assumptions) && c.assumptions.length > 0, 'assumptions are stated');
    assert.match(String(c.balanceAsOf || ''), /^\d{4}-\d{2}-\d{2}$/, 'the reported balance date is named');
    assert.equal(c.actualSaved ?? null, null, 'an estimate is never actual saved money');
    assert.equal(c.moneyMovementPermission, 'not-granted');
    assert.ok(Array.isArray(c.items) && c.items.length > 0, 'per-goal Saved is published');
    for (const item of c.items) assert.ok(Number.isFinite(item.forecastSaved), `${item.key || item.id} Saved is numeric`);
    const allocated = c.items.reduce((sum, i) => sum + i.forecastSaved, 0) + (c.unallocated || 0);
    assert.equal(Math.round(allocated * 100), Math.round(c.stock * 100), `${start}: goal allocations conserve the pot`);
  }
});

test('estimated pool rolls forward: sweeps land and goals pay on their dates', () => {
  const clean = stocks(advice(scenario(false)));
  const est = stocks(advice(scenario(true)));
  // The first future close starts from the reported balance plus a
  // non-negative estimated boundary credit.
  assert.ok(est[0] >= 119, 'estimate never drops below the reported balance');
  // Hand-derived: reported 119 + current boundary credit 400 (proven
  // transfers only; none in this ledger) = 519.
  assert.equal(est[0], 519);
  // Planned Savings moves across future periods.
  assert.ok(new Set(est).size > 1, 'Savings at period close is not frozen at one value');
  // Conservation: once the next payday sweep lands, money only moves between
  // Bills and Savings, so later closes match the verified walk whatever the
  // boundary assumption was.
  assert.deepEqual(est.slice(1), clean.slice(1));
  // The invented 1500 goal pays on its December date exactly once.
  assert.equal(est[3] - est[4], 1500);
});

test('current-period figures are untouched by the estimate', () => {
  const pick = a => {
    const v = a.payPeriodViews.find(p => p.start === '2026-10-02');
    return { income: v.incomeTotal, bad: v.balanceAfterDeductions, opening: v.opening };
  };
  assert.deepEqual(pick(advice(scenario(true))), pick(advice(scenario(false))));
});

test('current-period proposals and verified backing stay withheld under the estimate', () => {
  const a = advice(scenario(true));
  assert.equal(a.savingsFunding.status, 'unavailable');
  assert.equal(a.savingsFunding.backing.status, 'unavailable');
  const current = a.payPeriodViews.find(p => p.start === '2026-10-02');
  assert.equal(current.fromTodayFunding?.status, 'unavailable', 'no from-today proposal is minted');
  for (const p of a.payPeriodViews.filter(v => v.end >= '2026-10-07'))
    assert.equal(p.plannedCostFunding?.status, 'unavailable', `${p.start} Budget funding stays withheld`);
});

test('guards: holds outside the movement class stay withheld', () => {
  // Card coverage unconfirmed is PA-4 territory and an owner tagging ruling.
  const card = scenario(true);
  card.opts.currentPeriodActuals.cardCoverageRequired = true;
  const ac = advice(card);
  for (const start of FUTURE) assert.equal(closing(ac, start).status, 'unavailable', `${start} card hold stays withheld`);
  // Clean movements but card coverage unconfirmed also stays withheld.
  const cardOnly = scenario(false);
  cardOnly.opts.currentPeriodActuals.cardCoverageRequired = true;
  const acc = advice(cardOnly);
  for (const start of FUTURE) assert.equal(closing(acc, start).status, 'unavailable', `${start} card-only hold stays withheld`);
  // A negative reported stock is a protected deficit, never estimated.
  const negative = scenario(true);
  for (const obs of negative.plan.savingsPoolObservation?.accounts || []) obs.value = -Math.abs(obs.value || 1);
  const an = advice(negative);
  for (const start of FUTURE) {
    const c = closing(an, start);
    assert.notEqual(c.nature, 'reported-balance-estimate', `${start} negative stock is not estimated`);
  }
});

test('render: the estimate is tagged and explains its basis; the verified close is unchanged', () => {
  const SavingsInventory = require(path.join(process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..'), 'public/savings-inventory'));
  const render = (a, start) => {
    const view = a.savingsFunding.periodViews.find(p => p.start === start);
    return SavingsInventory.html(a.savingsFunding, { asOf: a.savingsFunding.asOf, advice: a, periodId: view.id });
  };
  const est = render(advice(scenario(true)), '2026-10-30');
  assert.match(est, /Savings at period close: ≈ \$1,599\.00 \(estimated\)\./);
  assert.match(est, /data-savings-closing-estimate/);
  assert.match(est, /Estimated from the reported Savings balance dated 2026-10-07\./);
  assert.match(est, /may or may not already be included/);
  assert.ok(est.includes('Verified backing is withheld: ' + MOVEMENT_REASON), 'the withheld reason is named');
  const clean = render(advice(scenario(false)), '2026-10-30');
  assert.match(clean, /Savings at period close: \$1,599\.00\./);
  for (const marker of ['data-savings-closing-estimate', 'Estimated from the reported Savings balance', 'period close: ≈', '(estimated).'])
    assert.ok(!clean.includes(marker), 'verified close carries no estimate marker: ' + marker);
});

test('render: a projected period keeps the estimated tag on each per-goal Saved figure', () => {
  const SavingsInventory = require(path.join(process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..'), 'public/savings-inventory'));
  for (const unqualified of [true, false]) {
    const a = advice(scenario(unqualified));
    const view = a.savingsFunding.periodViews.find(p => p.start === '2026-10-30');
    const html = SavingsInventory.html(a.savingsFunding, { asOf: a.savingsFunding.asOf, advice: a, periodId: view.id });
    const facts = attr => html.split(`<div class="savings-inventory-fact" data-savings-${attr}>`).slice(1)
      .map(part => part.split('</dd>')[0]);
    const saved = facts('backed').filter(fact => /\$\d/.test(fact));
    assert.ok(saved.length > 0, 'the projected close prints at least one per-goal Saved figure');
    for (const fact of saved) assert.match(fact, /<small>estimated<\/small>$/, 'a projected Saved figure keeps its estimated tag: ' + fact);
    for (const fact of facts('backed').filter(fact => !/\$\d/.test(fact)))
      assert.match(fact, /Unknown/, 'a projected Saved with no figure is Unknown');
  }
});

test('render: grouped members keep requirement trust on Needed and projection trust on Saved', () => {
  // Atlas finding 1 on 7f35c27: the closing-member join overwrote each
  // member's requirement trust with its Saved projection trust, so a
  // calculated Needed read estimated. Invented: the two confirmed goals of
  // the future-closing fixture (1,500 and 1,000) grouped as one goal.
  const root = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
  const SavingsInventory = require(path.join(root, 'public/savings-inventory'));
  const x = require('./fixtures/savings-future-closing-data')();
  for (const c of x.plan.commitments) c.group = 'trip';
  for (const pool of x.plan.savingsEarmarks.pools) {
    pool.goalRefs = (pool.goalRefs || []).filter(ref => !(ref.kind === 'commitment' && ['a', 'b'].includes(ref.id)));
  }
  x.plan.savingsEarmarks.pools[0].goalRefs.push({ kind: 'group', id: 'trip' });
  const a = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [] });
  const view = a.savingsFunding.periodViews.find(p => p.start === '2026-10-30');
  const pub = F.savingsFundingPublication(a.savingsFunding, { asOf: a.savingsFunding.asOf, advice: a, periodId: view.id });
  assert.equal(pub.forecastClosing.status, 'ready');
  assert.deepEqual(pub.forecastClosing.items.map(i => [i.trust, i.forecastTrust]),
    [['calculated', 'estimated'], ['calculated', 'estimated']], 'the publication keeps the two trusts apart');
  const html = SavingsInventory.html(a.savingsFunding, { asOf: a.savingsFunding.asOf, advice: a, periodId: view.id });
  const members = html.split('<li data-savings-member=').slice(1);
  assert.equal(members.length, 2, 'both grouped members render');
  for (const m of members) {
    const needed = m.split('data-savings-member-needed>')[1].split('</dd>')[0];
    const saved = m.split('data-savings-member-backed>')[1].split('</dd>')[0];
    assert.match(needed, /\$[\d,]+\.\d{2}$/, 'a calculated member Needed stays unmarked in a projected period: ' + needed);
    assert.doesNotMatch(needed, /estimated/, 'Needed never borrows the Saved projection trust');
    assert.match(saved, /<small>estimated<\/small>$/, 'member Saved at period close keeps its estimated tag: ' + saved);
  }
});

test('openings and sweeps derived from the estimated credit carry the estimated tag end-to-end', () => {
  const est = advice(scenario(true)).payPeriodViews.filter(p => FUTURE.includes(p.start));
  for (const v of est) {
    assert.equal(v.openingTrust, 'estimated', v.start + ' opening tagged estimated');
    assert.equal(v.paydaySweepTrust, 'estimated', v.start + ' sweep tagged estimated');
    assert.equal(v.openingBasis, 'reported-balance-movement-hold');
  }
  const current = advice(scenario(true)).payPeriodViews.find(p => p.start === '2026-10-02');
  assert.equal(current.openingTrust, undefined, 'the current period carries no estimate tag');
  for (const v of advice(scenario(false)).payPeriodViews)
    assert.ok(!('openingTrust' in v) && !('paydaySweepTrust' in v), v.start + ' verified rows gain no new fields');
});

// Systems Review BLOCKING 5711938781 (#797): the primary Budget consumer
// must carry the estimate qualification, not only the hidden inventory.
function budgetContext() {
  const fs = require('node:fs'), vm = require('node:vm');
  const root = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
  const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
  const ctx = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
    document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  ctx.window = ctx; ctx.matchMedia = () => ({ matches: false, addEventListener() {} });
  for (const script of ['app', 'bill-detail', 'savings-inventory', 'budget-surface', 'plan']) {
    if (script === 'bill-detail') vm.runInContext('App.boot=()=>{};', ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'public', script + '.js'), 'utf8'), ctx);
  }
  vm.runInContext('state.targetBuffer=20;state.extraDebtMonthly=0;state.debts=[];', ctx);
  return { ctx, run: code => vm.runInContext(code, ctx) };
}
function budgetCard(unqualified, start) {
  const x = scenario(unqualified), a = advice(x), { ctx, run } = budgetContext();
  ctx.src = { plan: x.plan, debts: [], asOf: x.asOf, advice: a, liveOverlay: x.opts.liveOverlay || null, weekly: 0, weeklyOverride: 0 };
  ctx.period = a.payPeriodViews.find(p => p.start === start);
  return run('budgetSavingsGoalsHtml(src,period,null)');
}
const markerless = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('primary Budget card: estimated close and per-goal Saved carry the marker and named basis', () => {
  const html = budgetCard(true, '2026-10-30');
  const stock = html.split('data-budget-savings-forecast-stock>')[1].split('</p>')[0];
  assert.match(stock, /≈/, 'Savings at period close is marked estimated');
  assert.match(markerless(stock), /estimated \$1,599\.00/);
  const basis = html.split('data-budget-savings-estimate-basis>')[1]?.split('</p>')[0];
  assert.ok(basis, 'the basis/reason is shown on the primary card, not only in the hidden panel');
  assert.match(basis, /reported Savings balance dated 2026-10-07/);
  assert.ok(basis.includes(MOVEMENT_REASON), 'the withheld verified reason is named');
  const goal = html.split('data-budget-savings-goal="commitment:a"')[1].split('</li>')[0];
  const saved = goal.split('class="budget-goal-amount">')[1].split('</span><small>Saved')[0];
  assert.match(saved, /≈/, 'per-goal Saved is marked estimated');
  assert.match(markerless(saved), /estimated \$1,500\.00/);
  const needed = goal.split('class="budget-goal-amount">')[2].split('<small>')[0];
  assert.doesNotMatch(needed, /≈/, 'Needed is a requirement, not an estimate');
});

test('primary Budget card: the verified projected close stays unmarked (clean control)', () => {
  const html = budgetCard(false, '2026-10-30');
  const stock = html.split('data-budget-savings-forecast-stock>')[1].split('</p>')[0];
  assert.match(stock, /\$1,599\.00/);
  assert.doesNotMatch(stock, /≈|estimated/);
  assert.ok(!html.includes('data-budget-savings-estimate-basis'), 'no estimate basis on the verified path');
  const goal = html.split('data-budget-savings-goal="commitment:a"')[1].split('</li>')[0];
  const saved = goal.split('class="budget-goal-amount">')[1].split('</span><small>Saved')[0];
  assert.doesNotMatch(saved, /≈/);
});
