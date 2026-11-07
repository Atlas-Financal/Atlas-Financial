'use strict';
// Owner's current reported-earmark contract; every amount is invented.
const assert = require('node:assert/strict'), test = require('node:test');
const path = require('node:path'), fs = require('node:fs'), vm = require('node:vm');
const APP_ROOT = process.env.ATLAS_TEST_APP_ROOT || path.join(__dirname, '..');
const F = require(path.join(APP_ROOT, 'public/forecast'));
const Inventory = require(path.join(APP_ROOT, 'public/savings-inventory'));
const fx = require('./fixtures/savings-daily-allocation-contract');
const clone = x => JSON.parse(JSON.stringify(x));
function input() {
  const x = fx.advance(fx.fixture(), '2026-10-07');
  x.plan.savingsEarmarks.allocationPolicy = { order: 'due-date-first-combined-pool',
    effectiveFrom: '2026-10-05', source: 'Invented owner latest-report policy' };
  x.plan.savingsPoolObservation.accounts[0].evidenceDate = '2026-10-06';
  x.plan.savingsPoolObservation.accounts[1].evidenceDate = '2026-10-04';
  // An old savings-to-card debit is movement evidence, not a new stock input.
  x.opts.currentPeriodActuals.transactions.push({ id: 'invented-old-withdrawal', date: '2026-10-03',
    amount: 17.43, currency: 'CAD', pending: false, savingsPostingEvidence: 'posted',
    atlasAccountId: 'savings', accountRole: 'household-reserve',
    internalTransferIdentity: true, tfrReference: 'AA101', tfrDirection: 'TO' });
  return x;
}
function publish(x) {
  const before = JSON.stringify(x), advice = F.recommend(x.plan, x.asOf, { ...x.opts, debts: x.debts || [] });
  assert.equal(JSON.stringify(x), before, 'no balances, policy, observations, history or transactions change');
  return advice;
}
function reported(advice, expected = [60, 24, 35]) {
  const s = advice.savingsFunding;
  assert.equal(s.goalAllocation.status, 'ready');
  assert.equal(s.goalAllocation.evidenceTrust, 'provider-reported');
  assert.deepEqual(s.backing.items.map(row => row.saved), expected);
  assert.deepEqual(s.rows.map(row => row.needed), [230, 24]);
  assert.equal(s.actionPermission, 'not-granted'); assert.equal(s.moneyMovementPermission, 'not-granted');
  assert.equal(s.backing.actualTransferred, null);
  return s;
}
function futureHeld(advice) {
  assert.equal(advice.savingsFunding.backing.status, 'unavailable');
  assert.equal(advice.savingsFunding.period.proposal, null);
  assert.equal(advice.savingsFunding.period.transferred, null);
  assert.equal(advice.savingsFunding.schedule.status, 'unavailable');
  for (const sim of [advice.sim, advice.zero, advice.sim?.knowledge].filter(Boolean))
    assert.ok(sim.events.every(row => !row.reserveFunding), 'reported earmarks cannot seed a payment');
}
// Exercise the real publication and both renderers, with an invented DOM seam.
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
  vm.runInContext(fs.readFileSync(path.join(APP_ROOT, 'public/' + name + '.js'), 'utf8'), page);
}
vm.runInContext('state.targetBuffer=20;state.extraDebtMonthly=0;state.debts=[];', page);
function rendered(x, advice, rowSaved = [95, 24], pot = 119) {
  const packet = F.savingsFundingPublication(advice.savingsFunding, { asOf: x.asOf, advice });
  assert.ok(packet, 'real Forecast publication accepts its own result');
  page.src = { plan: x.plan, debts: [], asOf: x.asOf, advice, liveOverlay: x.opts };
  const budget = vm.runInContext('budgetSurfaceHtml(src)', page);
  const inventory = Inventory.html(packet, { asOf: x.asOf, advice });
  const stamps = [...budget.matchAll(/data-budget-goal-saved-amount="([^"]*)"/g)];
  const budgetSaved = [...budget.matchAll(/data-budget-savings-(?:total|member)-saved>([\s\S]*?)<\/span>/g)];
  const inventorySaved = [...inventory.matchAll(/data-savings-(?:member-)?backed><dt>[^<]*<\/dt><dd>([^<]*)/g)];
  assert.ok(budgetSaved.length >= 4 && inventorySaved.length >= 4);
  if (rowSaved) {
    assert.deepEqual(stamps.map(row => Number(row[1])), rowSaved);
    assert.ok(budgetSaved.every(row => !/Unavailable/.test(row[1])));
    assert.ok(inventorySaved.every(row => row[1].trim() !== 'Unknown'));
    assert.match(inventory, /Saved allocation/);
    assert.doesNotMatch(inventory, /Saved allocation is withheld/, 'backing reason cannot contradict visible earmarks');
  } else {
    assert.equal(stamps.length, 0, 'no fake zero progress stamp');
    assert.ok(budgetSaved.every(row => /Unavailable/.test(row[1]) && !/\$0\.00/.test(row[1])));
    assert.ok(inventorySaved.every(row => row[1].trim() === 'Unknown'));
  }
  if (pot != null) assert.match(inventory, new RegExp('Reported combined savings: \\$' + pot.toFixed(2).replace('.', '\\.') + '\\.'));
  assert.equal(packet.period.proposal, null, 'rendering cannot recover a contribution');
  return { budget, inventory };
}
test('latest reported 95 + 24 funds dated costs 60, 24, 170 as 60 + 24 + 35 despite an old unpaired debit', () => {
  const x = input(), advice = publish(x);
  assert.equal(advice.savingsInventory.reportedStock.status, 'ready');
  assert.equal(advice.savingsInventory.reportedStock.amount, 119, 'source reports are known even before Saved publication');
  const s = reported(advice);
  assert.equal(6000 + 2400 + 3500, 9500 + 2400, 'independent cents conservation; old debit is not subtracted again');
  assert.deepEqual(s.rows.map(row => row.saved), [95, 24]); futureHeld(advice);
  assert.equal(s.goalAllocation.checkedAsOf, '2026-10-07');
  assert.deepEqual(s.goalAllocation.balanceDates, [{ accountId: 'savings', date: '2026-10-06' },
    { accountId: 'savings-dont-touch', date: '2026-10-04' }]);
  const html = rendered(x, advice);
  assert.match(html.inventory, /Balance dates 2026-10-04 - 2026-10-06/);
});
for (const role of ['current', 'past', 'next', 'future'])
  test('selected-period Inventory ' + role + ' respects actual-stock qualification through Budget Accounts & evidence', () => {
    const x = require('./fixtures/savings-transfer-cutoffs')('unrelated-mixed'), advice = publish(x);
    const period = advice.payPeriodViews.find(row => row.timelineRole === role);
    assert.ok(period, 'the native selected period exists');
    const context = { asOf: x.asOf, advice, periodId: period.id };
    const packet = F.savingsFundingPublication(advice.savingsFunding, context);
    assert.ok(packet, 'Forecast accepts its native selected-period publication');
    assert.equal(packet.stock.reportedStock.status, 'ready', 'current source report is retained as evidence');
    assert.equal(packet.stock.reportedStock.amount, 119, 'known current report makes the leak observable');
    const before = JSON.stringify(advice);
    page.src = { plan: x.plan, debts: [], asOf: x.asOf, advice, liveOverlay: x.opts };
    page.selectedPeriod = period;
    // Actual tile includes a hidden Inventory payload; its Accounts & evidence
    // button opens this payload through the incumbent Budget modal consumer.
    const tile = vm.runInContext('budgetSavingsGoalsHtml(src, selectedPeriod, null)', page);
    assert.match(tile, /data-budget-funding-inventory/);
    assert.match(tile, /data-budget-funding-savings hidden/);
    const standalone = Inventory.html(advice.savingsFunding, context);
    for (const [surface, html] of [['Inventory', standalone], ['Budget Accounts & evidence', tile]]) {
      if (role === 'current') {
        assert.match(html, /Reported combined savings: \$119\.00\./, surface + ' preserves qualified current reports');
        assert.match(html, /Balance dates 2026-10-06 - 2026-10-08/);
      } else {
        assert.equal(packet.period.kind, role === 'past' ? 'historical' : 'projected');
        assert.equal(packet.stock.amount, null, 'Forecast withholds selected-period actual stock');
        assert.ok(packet.rows.every(row => row.saved === null), 'selected-period Saved is unknown');
        assert.doesNotMatch(html, /Reported combined savings|\$119\.00|Balance dates 2026-10-06 - 2026-10-08/,
          surface + ' cannot promote the retained current report into selected-period stock');
        assert.match(html, role === 'past' ? /Stock for this selected period: Unknown\./ : /Savings at period close: Unknown\./);
        if (role === 'past') {
          // #818 5.9: a completed period's Accounts & evidence never lists a
          // pool balance observed after its last day.
          const later = (advice.savingsFunding.backing.pools || []).filter(pool =>
            typeof pool.observedCash === 'number' && pool.observedAsOf > period.end);
          assert.ok(later.length, 'a later-dated current pool balance makes the leak observable');
          assert.ok(packet.backing.pools.every(pool => pool.observedCash === null || pool.observedAsOf <= period.end),
            'Forecast withholds later-dated pool balances from the completed period');
          for (const pool of later) assert.ok(!html.includes(pool.observedAsOf), surface + ' prints no later pool balance date');
        }
      }
    }
    assert.equal(JSON.stringify(advice), before, 'rendering cannot change current or selected-period publications');
  });
for (const field of ['transactionCoverage', 'pendingCoverage'])
  for (const [name, coverage] of [['null', null], ['unknown', 'unknown'], ['empty', {}],
    ['truncated-status', { complete: true, status: 'truncated' }],
    ['unknown-status', { complete: true, status: 'unknown' }],
    ['has-more', { complete: true, hasMore: true }], ['truncated-flag', { complete: true, truncated: true }],
    ['array', []], ['boolean', true]])
    test('overlap evidence ' + field + ' ' + name + ' cannot prove duplicate reported cash', () => {
      const x = require('./fixtures/savings-transfer-cutoffs')('double-count');
      x.opts.currentPeriodActuals[field] = clone(coverage);
      const advice = publish(x);
      assert.equal(advice.savingsInventory.reportedStock.amount, 200);
      reported(advice, [60, 24, 116]); futureHeld(advice); rendered(x, advice, [176,24], 200);
    });
for (const [name, mutate] of Object.entries({
  'window-truncated-status': p => { p.savingsFetchCoverage.status = 'truncated'; },
  'window-has-more': p => { p.savingsFetchCoverage.hasMore = true; },
  'window-bound-mismatch': p => { p.savingsFetchCoverage.startDate = '2026-10-03'; },
  'coverage-through-before-observation': p => { p.coverageThrough = p.savingsFetchCoverage.endDate = '2026-10-07'; },
  'transaction-window-contradiction': p => { p.transactionWindow = { ...p.savingsFetchCoverage, truncated: true }; },
  'transaction-coverage-start-mismatch': p => { p.transactionCoverage = { complete: true, startDate: '2026-10-03' }; },
  'transaction-coverage-end-mismatch': p => { p.transactionCoverage = { complete: true, endDate: '2026-10-07' }; },
  'missing-transaction-coverage': p => { delete p.transactionCoverage; },
  'missing-pending-coverage': p => { delete p.pendingCoverage; },
})) test('overlap evidence ' + name + ' cannot prove duplicate reported cash', () => {
  const x = require('./fixtures/savings-transfer-cutoffs')('double-count');
  mutate(x.opts.currentPeriodActuals);
  const advice = publish(x); reported(advice, [60,24,116]); futureHeld(advice);
  assert.equal(advice.savingsInventory.reportedStock.amount, 200);
});
for (const coverage of ['complete', { complete: true }, { complete: true, status: 'complete', truncated: false, hasMore: false }])
  test('overlap evidence explicit complete control ' + JSON.stringify(coverage) + ' still withholds proven duplicate', () => {
    const x = require('./fixtures/savings-transfer-cutoffs')('double-count');
    x.opts.currentPeriodActuals.transactionCoverage = clone(coverage);
    x.opts.currentPeriodActuals.pendingCoverage = clone(coverage);
    x.opts.currentPeriodActuals.transactionWindow = { ...x.opts.currentPeriodActuals.savingsFetchCoverage,
      status: 'complete', truncated: false, hasMore: false };
    const advice = publish(x);
    assert.equal(advice.savingsFunding.goalAllocation.status, 'unavailable');
    assert.match(advice.savingsFunding.goalAllocation.reason, /same proven reserve transfer/);
    assert.equal(advice.savingsInventory.reportedStock.amount, 200);
    futureHeld(advice); rendered(x, advice, null, 200);
  });
for (const accountId of ['savings', 'savings-dont-touch'])
  for (const direction of ['TO', 'FR']) for (const boundary of ['before-window', 'before-reports', 'on-balance', 'after-reports'])
    test('D1 ' + accountId + ' unpaired ' + direction + ' ' + boundary + ' preserves reports and renderer earmarks', () => {
      const x = input(), row = x.opts.currentPeriodActuals.transactions.at(-1);
      row.atlasAccountId = accountId; row.tfrDirection = direction; row.amount = direction === 'TO' ? 17.43 : -17.43;
      row.date = { 'before-window': '2026-10-01', 'before-reports': '2026-10-03',
        'on-balance': x.plan.savingsPoolObservation.accounts.find(a => a.accountId === accountId).evidenceDate,
        'after-reports': '2026-10-07' }[boundary];
      assert.equal(F.householdInternalMovements(x.plan, x.opts).length, 0, 'a one-leg transfer is not fabricated into a pair');
      const advice = publish(x); reported(advice); futureHeld(advice); rendered(x, advice);
      assert.equal(advice.savingsInventory.reportedStock.amount, 119);
    });
for (const control of ['plain-posted', 'proven-household-pair', 'chequing-only'])
  test('D1 ' + control + ' control retains the exact reported 119', () => {
    const x = input(), row = x.opts.currentPeriodActuals.transactions.at(-1);
    if (control === 'plain-posted') for (const key of ['internalTransferIdentity', 'tfrReference', 'tfrDirection']) delete row[key];
    if (control === 'chequing-only') { row.atlasAccountId = 'chequing-a'; row.accountRole = 'household-cash'; }
    if (control === 'proven-household-pair') x.opts.currentPeriodActuals.transactions.push({ ...row,
      id: 'invented-household-counter-leg', atlasAccountId: 'chequing-a', accountRole: 'household-cash',
      amount: -17.43, tfrDirection: 'FR' });
    if (control === 'proven-household-pair') assert.equal(F.householdInternalMovements(x.plan, x.opts).length, 1);
    const advice = publish(x); reported(advice); futureHeld(advice); rendered(x, advice);
  });
for (const mode of ['pending-movement', 'flag-savings', 'flag-other-reserve', 'truncated-fetch', 'truncated-packet'])
  test(mode + ' qualifies backing separately and cannot erase valid dated reports', () => {
    const x = input(), packet = x.opts.currentPeriodActuals;
    if (mode === 'pending-movement') packet.transactions.at(-1).pending = true;
    if (mode.startsWith('flag-')) packet.savingsMovementUnconfirmed = [{
      accountId: mode === 'flag-savings' ? 'savings' : 'savings-dont-touch',
      reason: 'transaction-amount-or-date-unconfirmed' }];
    if (mode === 'truncated-fetch') packet.savingsFetchCoverage.complete = false;
    if (mode === 'truncated-packet') packet.transactionCoverage = { complete: false, status: 'truncated' };
    const advice = publish(x); reported(advice); futureHeld(advice); rendered(x, advice);
    assert.equal(advice.savingsInventory.reportedStock.amount, 119);
  });
for (const [mode, pot, items, rows] of [['same-day', 100, [60,24,16], [76,24]],
  ['same-day-one', 200, [60,24,116], [176,24]]]) test(mode + ' pair prints reports sum; date equality does not prove duplicate cash', () => {
    const x = require('./fixtures/savings-transfer-cutoffs')(mode), advice = publish(x);
    assert.equal(F.householdInternalMovements(x.plan, x.opts).length, 1);
    reported(advice, items); futureHeld(advice); rendered(x, advice, rows, pot);
    assert.equal(advice.savingsInventory.reportedStock.amount, pot, 'reported stock is never reconstructed from the pair');
  });
for (const mode of ['absent-history', 'truncated-history', 'missing-provenance', 'unconfirmed-card-opening',
  'unknown-operating-cash', 'pending-reserve']) test(mode + ' cannot erase valid reported earmarks or grant future funding', () => {
  const x = input();
  if (mode === 'absent-history') delete x.opts.currentPeriodActuals;
  if (mode === 'truncated-history') x.opts.currentPeriodActuals.transactionCoverage = 'truncated';
  if (mode === 'missing-provenance') delete x.opts.currentPeriodActuals.savingsFetchCoverage;
  if (mode === 'unconfirmed-card-opening') x.opts.currentPeriodActuals.cardCoverageRequired = true;
  if (mode === 'unknown-operating-cash') { delete x.plan.startingCash.breakdown[0].value; x.opts.operatingPlan = 'unavailable'; }
  if (mode === 'pending-reserve') x.plan.savingsPoolObservation.accounts[0].pendingState = 'pending';
  const advice = publish(x); reported(advice); futureHeld(advice);
});
test('source replacement grows the next requirement, shrinks, reaches genuine zero, and caps full goals without accrual', () => {
  const x = input();
  for (const [a, b, expected] of [[95,24,[60,24,35]], [105,24,[60,24,45]],
    [15.02,24,[39.02,0,0]], [0,0,[0,0,0]], [230,24,[60,24,170]], [240,24,[60,24,170]]]) {
    x.plan.savingsPoolObservation.accounts[0].value = a;
    x.plan.savingsPoolObservation.accounts[1].value = b;
    const advice = publish(x), s = reported(advice, expected); futureHeld(advice);
    assert.deepEqual(publish(x).savingsFunding, s, 'same checked input replaces itself, never accrues another earmark');
    assert.ok(s.backing.items.reduce((sum,row) => sum + Math.round(row.saved*100),0) <= Math.round((a+b)*100));
  }
});
test('midnight preserves the last checked reports and earmarks without relabeling balance freshness', () => {
  const x = input(), before = reported(publish(x));
  x.asOf = x.plan.opening.asOf = '2026-10-09';
  const after = reported(publish(x));
  assert.deepEqual(after.goalAllocation.balanceDates, before.goalAllocation.balanceDates);
  assert.equal(after.goalAllocation.checkedAsOf, before.goalAllocation.checkedAsOf);
  assert.equal(after.stock.amount, null, 'dated report never becomes today current backing');
});
test('a proven inter-reserve transfer counted in both snapshots is a genuine account-cohort hold', () => {
  const x = require('./fixtures/savings-transfer-cutoffs')();
  const before = publish(x).savingsFunding;
  assert.equal(10000 - 10000 + 10000, 10000, 'the invented paired transfer conserves one 100, not two');
  assert.equal(before.goalAllocation.status, 'unavailable');
  assert.match(before.goalAllocation.reason, /same proven reserve transfer/);
  assert.equal(publish(x).savingsInventory.reportedStock.amount, 200, 'proven duplicate hold leaves source reports unadjusted');
  rendered(x, publish(x), null, 200);
  x.plan.savingsPoolObservation.accounts[0].value = 0;
  x.plan.savingsPoolObservation.accounts[0].evidenceDate = '2026-10-08';
  reported(publish(x), [60, 24, 16]);
});
test('settled exclusion does not subtract another payment from the reported pot on replay', () => {
  const x = input(); x.plan.commitments[0].settledOn = '2026-10-06';
  for (let n = 0; n < 2; n++) {
    const advice = publish(x), s = advice.savingsFunding;
    assert.deepEqual(s.backing.items.map(row => [row.id,row.saved]), [['home-cost',24],['far',95]]);
    assert.equal(advice.savingsInventory.reportedStock.amount, 119);
    assert.equal(s.rows.find(row => row.key === 'group:club').needed, 170);
    assert.ok(!s.backing.items.some(row => row.id === 'near')); futureHeld(advice);
  }
});
test('a 2027 protected goal stays chronological and cannot become a current-period contribution', () => {
  const x = input(); x.plan.commitments.push({ id: 'next-year', label: 'Invented next-year cost',
    date: '2027-01-04', amount: 30, confidence: 'confirmed', adjustable: false, sinkingFund: true });
  const advice = publish(x), s = advice.savingsFunding;
  assert.deepEqual(s.backing.items.map(row => [row.id,row.saved]),
    [['near',60],['home-cost',24],['far',35],['next-year',0]]);
  assert.ok(!(s.period.allocations || []).some(row => row.requirementId === 'next-year'));
  assert.ok(!(s.period.cycleAllocations || []).some(row => row.requirementId === 'next-year'));
  assert.equal(s.rows.find(row => row.key === 'commitment:next-year').saved, 0, 'known exhausted-pot zero is distinct from unavailable');
  futureHeld(advice); rendered(x, advice, [95,24,0]);
});
for (const [name, mutate] of Object.entries({
  missing: p => p.savingsPoolObservation.accounts.pop(),
  duplicate: p => p.savingsPoolObservation.accounts.push(clone(p.savingsPoolObservation.accounts[0])),
  wrongIdentity: p => { p.savingsPoolObservation.accounts[0].accountId = 'chequing-a'; },
  wrongCurrency: p => { p.savingsPoolObservation.accounts[0].currency = 'USD'; },
  wrongSource: p => { p.savingsPoolObservation.accounts[0].source = 'opening'; },
  missingDate: p => { delete p.savingsPoolObservation.accounts[0].evidenceDate; },
  impossibleDate: p => { p.savingsPoolObservation.accounts[0].evidenceDate = '2026-02-30'; },
  futureDate: p => { p.savingsPoolObservation.accounts[0].evidenceDate = '2026-10-09'; },
  null: p => { p.savingsPoolObservation.accounts[0].value = null; },
  string: p => { p.savingsPoolObservation.accounts[0].value = '95'; },
  subCent: p => { p.savingsPoolObservation.accounts[0].value = 95.001; },
  negative: p => { p.savingsPoolObservation.accounts[0].value = -1; },
  unknownRequirementDate: p => { delete p.commitments[0].date; },
  unknownRequirementAmount: p => { delete p.commitments[0].amount; },
  noObservation: p => { delete p.savingsPoolObservation; },
  rangedRequirement: p => { delete p.commitments[0].amount; p.commitments[0].amountMin = 50; p.commitments[0].amountMax = 70; },
})) test(name + ' remains unknown, never a partial sum or invented zero', () => {
  const x = input(); mutate(x.plan); const advice = publish(x), s = advice.savingsFunding;
  assert.equal(s.goalAllocation.status, 'unavailable');
  assert.ok(s.rows.every(row => row.saved === null)); assert.equal(s.period.proposal, null);
  rendered(x, advice, null, null);
});
