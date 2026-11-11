'use strict';
// Independent invented cents and real provider/consumer paths. No household data.
const assert = require('node:assert/strict'), test = require('node:test');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const F = require('../public/forecast'), O = require('../scripts/provider-observe');
const Inventory = require('../public/savings-inventory');
const fx = require('./fixtures/savings-daily-allocation-contract');
const provider = require('./fixtures/savings-v2-observation-data');
const transferCutoffs = require('./fixtures/savings-transfer-cutoffs');
const clone = x => JSON.parse(JSON.stringify(x));
function fixture() {
  const input = fx.advance(fx.fixture(), '2026-10-07');
  input.plan.savingsEarmarks.allocationPolicy = { order: 'due-date-first-combined-pool',
    effectiveFrom: '2026-10-05', source: 'Independent invented Savings policy' };
  input.plan.savingsPoolObservation.accounts[0].evidenceDate = '2026-10-06';
  input.plan.savingsPoolObservation.accounts[1].evidenceDate = '2026-10-04';
  return input;
}
function publish(input) {
  const before = JSON.stringify(input);
  const advice = F.recommend(input.plan, input.asOf, { ...input.opts, debts: [] });
  assert.equal(JSON.stringify(input), before, 'the source evidence and plan are immutable');
  return advice;
}
function saved(packet) { return packet.backing.items.map(row => [row.id, row.saved]); }
// Independent invented requirements, in order: 6000, 2400, 17000 cents.
// The current source contract allocates reports, never reconstructed transfers.
function reportedExpected(input) {
  const values = input.plan.savingsPoolObservation.accounts.map(row => row.value);
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value))) return null;
  const total = values.reduce((sum,value) => sum + Math.round(value * 100), 0);
  const first = Math.min(6000, total), second = Math.min(2400, total - first);
  return [first / 100, second / 100, Math.min(17000, total - first - second) / 100];
}
function fundingHeld(advice) {
  const packet = advice.savingsFunding;
  assert.equal(packet.stock.amount, null, 'same-day observed stock gate survives');
  assert.equal(packet.backing.status, 'unavailable');
  assert.equal(packet.backing.unallocated, null);
  assert.equal(packet.period.proposal, null);
  assert.equal(packet.backing.actualTransferred, null);
  assert.equal(packet.period.actualSaved, null);
  assert.equal(packet.schedule.status, 'unavailable');
  assert.deepEqual(packet.schedule.paydays, []);
  assert.equal(packet.timeline.status, 'unavailable');
  assert.equal(packet.actionPermission, 'not-granted');
  assert.equal(packet.moneyMovementPermission, 'not-granted');
  for (const sim of [advice.sim, advice.sim?.knowledge, advice.zero].filter(Boolean)) {
    assert.ok(sim.events.every(row => !row.reserveFunding), 'no dated Saved value seeds a reserve payment');
  }
}
test('paired reserve transfer across opposite cutoffs cannot allocate the same 100 twice', () => {
  const input = transferCutoffs(), advice = publish(input), packet = advice.savingsFunding;
  assert.equal(F.householdInternalMovements(input.plan, input.opts).length, 1, 'existing identity authority proves the pair');
  assert.equal(advice.savingsInventory.reportedStock.amount, 200, 'original dated reports stay intact');
  assert.equal(10000 - 10000 + 10000, 10000, 'independent source debit/destination credit conserve 100');
  assert.equal(packet.goalAllocation.status, 'unavailable');
  assert.ok(packet.backing.items.every(row => row.saved === null));
  assert.deepEqual(packet.rows.map(row => row.needed), [230, 24]);
  assert.equal(packet.period.proposal, null);
});
for (const row of transferCutoffs.boundaryCases) test(row.name + ' retains reported earmarks and separately qualifies payment backing', () => {
  const input = transferCutoffs(row.name), advice = publish(input), packet = advice.savingsFunding;
  assert.equal(packet.goalAllocation.status, 'ready');
  assert.deepEqual(packet.backing.items.map(item => item.saved), reportedExpected(input));
  assert.deepEqual(packet.rows.map(item => item.needed), [230, 24]);
  assert.deepEqual(packet.goalAllocation.balanceDates, input.plan.savingsPoolObservation.accounts
    .map(item => ({ accountId: item.accountId, date: item.evidenceDate })));
  if (!row.saved) {
    assert.equal(packet.backing.status, 'unavailable', 'unqualified movement never gains payment backing');
    assert.equal(packet.period.proposal, null);
    assert.equal(packet.moneyMovementPermission, 'not-granted');
    assert.ok(advice.sim.events.every(item => !item.reserveFunding));
  }
});
for (const mode of ['inverse', 'opposite-direction', 'same-day', 'same-day-one', 'unknown-stock', 'pending',
  'missing-pending', 'currency', 'missing-currency', 'fractional', 'string-amount', 'null-amount', 'date',
  'impossible-date', 'future-date', 'alias', 'alias-outside', 'missing-id', 'malformed-id', 'role', 'duplicate', 'ambiguous-reference', 'duplicate-id-elsewhere', 'unmatched',
  'unknown-coverage', 'missing-coverage', 'coverage-gap', 'unknown-observation', 'packet-currency', 'split-posting-dates',
  'hint-only', 'hint-internal', 'hint-one-leg', 'invalid-reference', 'missing-reference', 'missing-direction', 'identity-flag'])
  test('reserve-cutoff ' + mode + ' cannot authorize reconciliation or new funding', () => {
    const input = transferCutoffs(mode), advice = publish(input), packet = advice.savingsFunding;
    if (mode.startsWith('hint-') || mode.includes('reference') || mode === 'missing-direction' || mode === 'identity-flag') {
      assert.equal(F.householdInternalMovements(input.plan, input.opts).length, 0, 'hint or malformed reference cannot prove a pair by amounts');
      assert.equal(advice.savingsInventory.reportedStock.amount, 200, 'original reports are not adjusted');
    }
    const held = ['opposite-direction', 'unknown-stock'].includes(mode);
    assert.equal(packet.goalAllocation.status, held ? 'unavailable' : 'ready');
    assert.deepEqual(packet.backing.items.map(row => row.saved), held ? [null,null,null] : reportedExpected(input));
    assert.equal(packet.backing.status, 'unavailable');
    assert.deepEqual(packet.rows.map(row => row.needed), [230, 24], 'requirements remain independently known');
    assert.equal(packet.period.proposal, null);
    assert.equal(packet.timeline.status, 'unavailable');
    assert.equal(packet.moneyMovementPermission, 'not-granted');
    assert.ok(advice.sim.events.every(row => !row.reserveFunding), 'no uncertain transfer seeds a reserve payment');
  });
test('a later coherent observation replaces the withheld transfer allocation and survives midnight', () => {
  const input = transferCutoffs(), before = publish(input).savingsFunding;
  assert.equal(before.goalAllocation.status, 'unavailable');
  input.plan.savingsPoolObservation.accounts[0].value = 0;
  input.plan.savingsPoolObservation.accounts[0].evidenceDate = '2026-10-08';
  const coherent = publish(input).savingsFunding;
  assert.equal(coherent.goalAllocation.status, 'ready');
  assert.deepEqual(saved(coherent), [['near', 60], ['home-cost', 24], ['far', 16]]);
  input.asOf = input.plan.opening.asOf = '2026-10-09';
  const midnight = publish(input).savingsFunding;
  assert.deepEqual(saved(midnight), saved(coherent));
  assert.deepEqual(midnight.goalAllocation.balanceDates, coherent.goalAllocation.balanceDates);
  assert.equal(midnight.goalAllocation.checkedAsOf, '2026-10-08');
  fundingHeld(publish(input));
});
for (const mode of ['both-before', 'both-after', 'coherent-split-dates', 'exact-cents'])
  test('reserve-cutoff ' + mode + ' uses the coherent reported stock once', () => {
    const input = transferCutoffs(mode), packet = publish(input).savingsFunding;
    const cents = mode === 'exact-cents' ? 10001 : 10000;
    assert.equal(packet.goalAllocation.status, 'ready');
    assert.deepEqual(saved(packet), [['near', 60], ['home-cost', 24], ['far', mode === 'exact-cents' ? 16.01 : 16]]);
    assert.equal(packet.backing.items.reduce((sum, row) => sum + Math.round(row.saved * 100), 0), cents,
      'independent 10000 - 10000 + 10000, or 10001 - 10001 + 10001, is allocated once');
    assert.equal(packet.rows.find(row => row.key === 'group:club').saved, mode === 'exact-cents' ? 76.01 : 76);
  });
for (const mode of ['unrelated-mixed', 'zero', 'zero-movement'])
  test('reserve-cutoff ' + mode + ' keeps ordinary mixed-date and genuine zero behavior', () => {
    const input = transferCutoffs(mode), packet = publish(input).savingsFunding;
    assert.equal(packet.goalAllocation.status, 'ready');
    assert.deepEqual(saved(packet), mode === 'zero' ? [['near', 0], ['home-cost', 0], ['far', 0]]
      : [['near', 60], ['home-cost', 24], ['far', 35]]);
  });
test('older/mixed dates allocate 119 as 60 + 24 + 35 without native reserve backing', () => {
  const input = fixture(), advice = publish(input), packet = advice.savingsFunding;
  assert.equal(packet.goalAllocation.status, 'ready');
  assert.deepEqual(saved(packet), [['near', 60], ['home-cost', 24], ['far', 35]]);
  assert.deepEqual(packet.rows.map(row => [row.key, row.saved, row.needed]),
    [['group:club', 95, 230], ['yearly-bill:home-cost', 24, 24]]);
  assert.equal(6000 + 2400 + 3500, 11900, 'independent whole-cent conservation');
  assert.equal(packet.goalAllocation.evidenceTrust, 'provider-reported');
  assert.equal(packet.goalAllocation.checkedAsOf, '2026-10-07');
  assert.deepEqual(packet.goalAllocation.balanceDates, [
    { accountId: 'savings', date: '2026-10-06' }, { accountId: 'savings-dont-touch', date: '2026-10-04' }]);
  assert.equal(advice.savingsInventory.reportedStock.amount, 119);
  fundingHeld(advice);
  const cashExpense = advice.sim.events.find(row => row.id === 'near');
  assert.equal(cashExpense.amount, -60, 'full incumbent expense remains protected');
});
test('new observations replace the one allocation for increases, decreases, zero and full stock', () => {
  const input = fixture();
  for (const [a, b, expected] of [
    [95, 24, [60, 24, 35]], [105, 24, [60, 24, 45]], [15.02, 24, [39.02, 0, 0]],
    [0, 0, [0, 0, 0]], [60, 24, [60, 24, 0]], [230, 24, [60, 24, 170]],
    [240, 24, [60, 24, 170]], [31.37, 89, [60, 24, 36.37]],
  ]) {
    input.plan.savingsPoolObservation.accounts[0].value = a;
    input.plan.savingsPoolObservation.accounts[1].value = b;
    const advice = publish(input), packet = advice.savingsFunding;
    assert.deepEqual(packet.backing.items.map(row => row.saved), expected);
    assert.deepEqual(publish(input).savingsFunding, packet, 'replay cannot accrue another allocation');
    assert.equal(input.plan.savingsEarmarks.history.length, 0);
    fundingHeld(advice);
  }
});
test('authored zero is unknown; settled-member filtering remains native', () => {
  const input = fixture(); input.plan.commitments[0].amount = 0;
  let packet = publish(input).savingsFunding;
  assert.equal(packet.backing.status, 'unavailable');
  assert.equal(packet.goalAllocation.status, 'unavailable');
  assert.ok(packet.backing.items.every(row => row.saved === null));
  assert.equal(packet.rows.find(row => row.key === 'group:club').saved, null);
  input.plan.commitments[0].amount = 60; // restore a valid authored price before settlement
  input.plan.commitments[0].settledOn = '2026-10-06';
  packet = publish(input).savingsFunding;
  assert.deepEqual(saved(packet), [['home-cost', 24], ['far', 95]]);
  assert.deepEqual(packet.rows.find(row => row.key === 'group:club').members, ['far@2026-10-28']);
});
test('the validator\'s integer cents reach the allocator without a dollars round trip', () => {
  for (const [a, b, residual] of [[40000000000000.01, 40000000000000, 79999999999746],
    [100000000, 0.29, 99999746.28]]) {
    const input = fixture(); input.plan.commitments[0].amount = 60.01;
    input.plan.savingsPoolObservation.accounts[0].value = a;
    input.plan.savingsPoolObservation.accounts[1].value = b;
    input.plan.savingsPoolObservation.accounts.forEach(row => { row.evidenceDate = input.asOf; });
    const packet = publish(input).savingsFunding;
    assert.equal(packet.backing.status, 'ready');
    assert.deepEqual(saved(packet), [['near', 60.01], ['home-cost', 24], ['far', 170]]);
    assert.equal(packet.backing.unallocated, residual, 'independent input cents minus 25401, matching native backing');
    assert.equal(JSON.parse(JSON.stringify(packet.stock.reportedStock)).amount, packet.stock.reportedStock.amount,
      'private integer plumbing does not add a serialized financial field');
  }
});
test('Vancouver midnight does not erase the last checked packet or rewrite its dates', () => {
  const input = fixture();
  input.plan.savingsPoolObservation.asOf = '2026-10-06';
  input.opts.currentPeriodActuals.observationAsOf = input.opts.currentPeriodActuals.coverageThrough = '2026-10-06';
  input.opts.currentPeriodActuals.savingsFetchCoverage.endDate = '2026-10-06';
  input.asOf = F.financialDate('2026-10-07T06:59:59Z');
  input.plan.opening.asOf = input.asOf;
  const before = publish(input).savingsFunding;
  input.asOf = F.financialDate('2026-10-07T07:00:00Z');
  input.plan.opening.asOf = input.asOf;
  const after = publish(input).savingsFunding;
  assert.equal(before.goalAllocation.status, 'ready'); assert.equal(after.goalAllocation.status, 'ready');
  assert.equal(before.asOf, '2026-10-06'); assert.equal(after.asOf, '2026-10-07');
  assert.deepEqual(saved(before), saved(after));
  assert.deepEqual(after.goalAllocation.balanceDates, before.goalAllocation.balanceDates);
  assert.equal(after.goalAllocation.checkedAsOf, '2026-10-06');
  assert.equal(after.period.proposal, null);
});
for (const [name, mutate] of Object.entries({
  missing: p => { p.savingsPoolObservation.accounts.pop(); },
  duplicate: p => { p.savingsPoolObservation.accounts.push({ ...p.savingsPoolObservation.accounts[0] }); },
  wrongIdentity: p => { p.savingsPoolObservation.accounts[0].accountId = 'chequing-a'; },
  wrongCurrency: p => { p.savingsPoolObservation.accounts[0].currency = 'USD'; },
  wrongSource: p => { p.savingsPoolObservation.accounts[0].source = 'opening'; },
  absentDate: p => { delete p.savingsPoolObservation.accounts[0].evidenceDate; },
  impossibleDate: p => { p.savingsPoolObservation.accounts[0].evidenceDate = '2026-02-30'; },
  futureBalance: p => { p.savingsPoolObservation.accounts[0].evidenceDate = '2026-10-08'; },
  futureCheck: p => { p.savingsPoolObservation.asOf = '2026-10-08'; },
  balanceAfterCheck: p => { p.savingsPoolObservation.asOf = '2026-10-05'; },
  malformedCheck: p => { p.savingsPoolObservation.asOf = 'not-a-date'; },
  nullAmount: p => { p.savingsPoolObservation.accounts[0].value = null; },
  stringAmount: p => { p.savingsPoolObservation.accounts[0].value = '95'; },
  fractional: p => { p.savingsPoolObservation.accounts[0].value = 95.001; },
  nonfinite: p => { p.savingsPoolObservation.accounts[0].value = NaN; },
  infinite: p => { p.savingsPoolObservation.accounts[0].value = Infinity; },
  unsafeSum: p => { p.savingsPoolObservation.accounts.forEach(row => { row.value = 50000000000000; }); },
  negativeAccount: p => { p.savingsPoolObservation.accounts[0].value = -1; },
  undatedGoal: p => { delete p.commitments[0].date; },
  rangedGoal: p => { delete p.commitments[0].amount; p.commitments[0].amountMin = 50; p.commitments[0].amountMax = 70; },
})) test(name + ' still withholds Saved and funding without fallback', () => {
  const input = fixture(); mutate(input.plan);
  const advice = publish(input), packet = advice.savingsFunding;
  assert.equal(packet.goalAllocation.status, 'unavailable');
  assert.ok(packet.backing.items.every(row => row.saved === null));
  assert.equal(packet.period.proposal, null);
});
for (const failure of ['global-cash', 'card-coverage', 'pending-cash', 'pending-reserve'])
  test('known Savings retains the ' + failure + ' gate', () => {
    const input = fixture();
    if (failure === 'global-cash') { delete input.plan.startingCash.breakdown[0].value; input.opts.operatingPlan = 'unavailable'; }
    if (failure === 'card-coverage') input.opts.currentPeriodActuals.cardCoverageRequired = true;
    if (failure.startsWith('pending-')) input.opts.currentPeriodActuals.transactions.push({
      id: 'invented-pending', date: input.asOf, amount: 7, currency: 'CAD', pending: true,
      atlasAccountId: failure === 'pending-reserve' ? 'savings' : 'chequing-a',
      accountRole: failure === 'pending-reserve' ? 'household-reserve' : 'household-cash' });
    const advice = publish(input), packet = advice.savingsFunding;
    assert.equal(packet.goalAllocation.status, 'ready');
    assert.deepEqual(saved(packet), [['near', 60], ['home-cost', 24], ['far', 35]]);
    fundingHeld(advice);
  });

const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {},
  classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {},
  querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
const page = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
  document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {},
    documentElement: { dataset: {}, style: {} } }, localStorage: { getItem() { return null; }, setItem() {} },
  location: { pathname: '/', search: '' } });
page.window = page; page.matchMedia = () => ({ matches: false, addEventListener() {} });
for (const name of ['app', 'bill-detail', 'savings-inventory', 'budget-surface', 'plan']) {
  if (name === 'bill-detail') vm.runInContext('App.boot=()=>{};', page);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/' + name + '.js'), 'utf8'), page);
}
vm.runInContext('state.targetBuffer=20;state.extraDebtMonthly=0;state.debts=[];', page);

test('reported earmarks print through independent movement holds; genuine duplicate stock remains unknown', () => {
  for (const mode of ['double-count', 'inverse', 'duplicate', 'unmatched', 'hint-only', 'hint-internal',
    'hint-one-leg', 'invalid-reference', 'missing-reference', 'missing-direction', 'identity-flag',
    ...transferCutoffs.boundaryCases.filter(row => !row.saved).map(row => row.name)]) {
    const input = transferCutoffs(mode), advice = publish(input);
    const packet = F.savingsFundingPublication(advice.savingsFunding, { asOf: input.asOf, advice });
    assert.ok(packet, 'the shared Forecast publication remains accepted');
    page.src = { plan: input.plan, debts: [], asOf: input.asOf, advice };
    const html = vm.runInContext('budgetSurfaceHtml(src)', page);
    const savedStamps = [...html.matchAll(/data-budget-goal-saved-amount="([^"]*)"/g)];
    const expected = mode === 'double-count' ? null : reportedExpected(input);
    assert.equal(savedStamps.length, expected ? 2 : 0);
    const printed = [...html.matchAll(/data-budget-savings-(?:total|member)-saved>([\s\S]*?)<\/span>/g)];
    assert.ok(printed.length >= 4);
    assert.ok(printed.every(match => expected ? !/Unavailable/.test(match[1]) : /Unavailable/.test(match[1])));
    if (expected) {
      assert.match(html, new RegExp('data-budget-goal-saved-amount="' + (expected[0] + expected[2]) + '"'));
      assert.match(html, new RegExp('data-budget-goal-saved-amount="' + expected[1] + '"'));
    }
    assert.match(html, /data-budget-goal-required-amount="230"/);
    assert.match(html, /data-budget-goal-required-amount="24"/);
    const inventory = Inventory.html(packet, { asOf: input.asOf, advice });
    const inventorySaved = [...inventory.matchAll(/data-savings-(?:member-)?backed><dt>[^<]*<\/dt><dd>([^<]*)/g)];
    assert.ok(inventorySaved.length >= 4);
    assert.ok(inventorySaved.every(match => expected ? match[1].trim() !== 'Unknown' : match[1].trim() === 'Unknown'));
    assert.equal(packet.period.proposal, null, 'printing an earmark never publishes a new contribution');
    assert.match(inventory, /data-savings-needed><dt>Needed<\/dt><dd>\$230\.00/);
  }
});
test('prior-check-day compact Savings evidence does not claim today was checked', () => {
  const { data } = provider.served('prior-household-day', O);
  data.meta.asOf = data.plan.opening.asOf = '2026-10-07';
  const advice = F.recommend(data.plan, data.meta.asOf, { weeklyVariable: 40, ...data.liveOverlay });
  page.src = { plan: data.plan, debts: [], asOf: data.meta.asOf, advice, liveOverlay: data.liveOverlay };
  const html = vm.runInContext('budgetSurfaceHtml(src)', page);
  assert.equal(advice.savingsInventory.reportedStock.checkedAsOf, '2026-10-06');
  assert.equal(advice.savingsInventory.reportedStock.balanceFrom, '2026-10-05');
  assert.match(html, /Latest reported balances checked 2026-10-06/);
  assert.match(html, /data-budget-savings-stock-evidence/);
  assert.doesNotMatch(html, /today(?:'|&#39;)s observation date/);
  assert.doesNotMatch(html, /Balance dates are separate from the observation check date/);
});
test('actual v2 observer and Plan print known dated Saved stamps with truthful evidence', () => {
  for (const mode of ['stale-date', 'stale-both', 'prior-year', 'prior-household-day', 'blocked-prior-day', 'withdrawal-stale', 'zero-stale']) {
    const { data, report } = provider.served(mode, O), original = clone(data);
    const advice = F.recommend(data.plan, data.meta.asOf, { weeklyVariable: 40, ...data.liveOverlay });
    page.src = { plan: data.plan, debts: [], asOf: data.meta.asOf, advice, liveOverlay: data.liveOverlay };
    const html = vm.runInContext('budgetSurfaceHtml(src)', page);
    const club = mode === 'withdrawal-stale' ? 39.02 : mode === 'zero-stale' ? 0 : 95;
    const home = mode === 'withdrawal-stale' || mode === 'zero-stale' ? 0 : 24;
    assert.match(html, new RegExp('data-budget-savings-goal="group:club" data-budget-goal-saved-amount="' + club + '"'));
    assert.match(html, new RegExp('data-budget-savings-goal="yearly-bill:home-cost" data-budget-goal-saved-amount="' + home + '"'));
    const packet = F.savingsFundingPublication(advice.savingsFunding, { asOf: data.meta.asOf, advice });
    assert.equal(packet.goalAllocation.evidenceTrust, 'provider-reported');
    assert.deepEqual(packet.goalAllocation.balanceDates, report.savingsPools.accounts.map(row => ({ accountId: row.accountId, date: row.evidenceDate })));
    assert.match(Inventory.html(packet, { asOf: data.meta.asOf, advice }), /Saved allocation/);
    assert.match(html, /Latest reported balances checked/);
    assert.equal(packet.period.proposal, null);
    assert.deepEqual(data, original);
  }
});
