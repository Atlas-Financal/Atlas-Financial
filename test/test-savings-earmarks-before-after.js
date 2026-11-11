'use strict';
const { stripUnconfirmedBills } = require('./lib/unconfirmed-bills-addition');
// Immutable prior engine on identical synthetic inputs. This is acceptance
// evidence against fresh main, not a replacement for the full financial suite.
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const F = require('../public/forecast');
const incumbentAdvice = require('./bills-period-end-legacy-comparison');
const { AS_OF, fixture, observedPlan, clone } = require('./fixtures/savings-earmarks');
const BASE = '210fb231bff9422fa9eca568b4e0acb68cece854';
const ROOT = path.join(__dirname, '..');
const source = execFileSync('git', ['show', BASE + ':public/forecast.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const prior = new Module(path.join(ROOT, 'public', 'forecast-before-savings.cjs'));
prior.filename = path.join(ROOT, 'public', 'forecast-before-savings.cjs');
prior.paths = Module._nodeModulePaths(path.dirname(prior.filename)); prior._compile(source, prior.filename);
const before = prior.exports, { data } = fixture(); data.plan = observedPlan();
// This immutable no-card-evidence probe isolates savings configuration.
delete data.plan.cardPurchaseCoverage;
const opts = { debts: data.debts, extraFacilities: data.revolvingExtra };
const old = before.recommend(data.plan, AS_OF, opts), current = F.recommend(data.plan, AS_OF, opts);
assert.equal(typeof before.savingsInventory, 'undefined'); assert.equal(old.savingsInventory, undefined);
assert.notEqual(old.planSpendPaydayFunding.status, 'unavailable', 'old zero-baseline instruction remains active on configured intent');
assert.equal(current.planSpendPaydayFunding.status, 'unavailable');
assert.deepEqual(current.savingsInventory.pools.map(p => [p.intent, p.unallocated]), [[247.80, 53.37], [99.99, 44.09]]);
const empty = clone(data.plan); delete empty.savingsEarmarks; delete empty.savingsPoolObservation;
// Bills audit of 57cb421: the frozen side drops only lookback BAD figures.
const legacyBefore = require('./bad-full-load-legacy').frozen(before.recommend(empty, AS_OF, opts)),
  legacyAfter = F.recommend(empty, AS_OF, opts);
// Exactly these three synthetic native commitments have fixed original costs.
// Pin expectations to the unchanged immutable engine, never the current packet.
const nativeCommitmentIds = ['trip-a', 'club-first', 'club-second'];
assert.deepEqual(empty.commitments.map(row => row.id).sort(), nativeCommitmentIds.slice().sort());
const immutableCommitmentCosts = new Map();
for (const id of nativeCommitmentIds) {
  const native = empty.commitments.filter(row => row.id === id);
  assert.equal(native.length, 1); assert.equal(typeof native[0].amount, 'number');
  assert.equal(native[0].settledOn, undefined);
  for (const field of ['fundingSequence', 'majorPlans']) {
    const original = legacyBefore[field].filter(row => row.id === id);
    assert.equal(original.length, 1, field + ': one immutable native counterpart');
    assert.equal(original[0].need, native[0].amount, 'immutable no-evidence need is the fixture fixed cost');
  }
  immutableCommitmentCosts.set(id, legacyBefore.fundingSequence.find(row => row.id === id).need);
}
// Budget progress deliberately adds a read-only namespace to period records.
// Validate that namespace on each concrete publication path, then compare
// every incumbent field to the immutable engine. No incumbent money/trust field is
// omitted, no baseline moves, and unexpected additions still fail equality.
// The new bill display-provenance fields are also validated independently
// against the immutable schedule rows: this probe supplies no actual packet.
// Authorized wording-only change (owner decision 2026-11-11, explainer trim): an evidence
// failure's advice sentence (`action`) is no longer printed. Only that prose is blanked, on both
// sides; each failure's code, message and every other field still agree exactly.
const blankActions = v => {
  if (v && typeof v === 'object') {
    if (typeof v.action === 'string' && typeof v.code === 'string' && typeof v.message === 'string') v.action = '';
    Object.values(v).forEach(blankActions);
  }
  return v;
};
const sameAsLegacy = (actual, expected, message) => assert.deepEqual(blankActions(clone(actual)), blankActions(clone(expected)), message);
function incumbentPublication(value) {
  const copy = stripUnconfirmedBills(clone(incumbentAdvice(value, AS_OF))).advice;
  // Admit only six complete, positively validated additive packets. All old
  // fields and any cost namespace outside these exact rows remain compared.
  for (const field of ['fundingSequence', 'majorPlans']) {
    assert.ok(Array.isArray(copy[field]));
    const seen = new Set();
    for (const row of copy[field]) {
      if (!immutableCommitmentCosts.has(row.id)) {
        assert.equal(Object.hasOwn(row, 'commitmentCost'), false,
          field + ': noncommitment row cannot carry the new namespace');
        continue;
      }
      assert.equal(seen.has(row.id), false, field + ': native cost identity is unique');
      seen.add(row.id);
      assert.deepEqual(row.commitmentCost, {
        asOf: AS_OF,
        originalCost: { status: 'known', amount: immutableCommitmentCosts.get(row.id), range: null },
        confirmedLinkedPaid: { status: 'unconfigured', amount: null, range: null },
        unpaidCost: { status: 'unconfigured', amount: null, range: null },
      }, field + ': complete cost packet agrees with immutable fixed-cost expectations');
      delete row.commitmentCost;
    }
    assert.deepEqual(Array.from(seen).sort(), nativeCommitmentIds.slice().sort(),
      field + ': all three expected native packets are present');
  }
  const periodSets = [copy.defaultView.calendarPeriods, copy.pastPeriodViews, copy.payPeriodViews];
  let count = 0;
  for (const periods of periodSets) for (const period of periods) {
    const progress = period.budgetProgress;
    assert.equal(period.budgetProgressAsOf, AS_OF);
    assert.equal(progress.source, 'Forecast.budgetPeriodProgress');
    assert.equal(progress.asOf, AS_OF);
    assert.equal(progress.start, period.start); assert.equal(progress.end, period.end);
    assert.equal(progress.currency, 'CAD');
    assert.ok(Array.isArray(progress.savings.goals));
    for (const goal of progress.savings.goals) {
      assert.equal(goal.status, 'not-confirmed');
      assert.equal(goal.fulfilled.amount, null); assert.equal(goal.remaining.amount, null);
    }
    if (progress.role === 'future') for (const name of ['income', 'bills', 'household', 'savings']) {
      assert.equal(progress[name].actual.amount, null, 'future projections never become fulfilled actuals');
    }
    const original = legacyBefore.payPeriodViews.find(p => p.id === period.id);
    assert.ok(original, 'every period still has its immutable counterpart');
    for (const bill of period.bills) {
      const priorBill = original.bills.find(b => b.id === bill.id && b.date === bill.date);
      assert.ok(priorBill, 'every bill still has its exact immutable occurrence');
      assert.equal(bill.displayAmountBasis, 'schedule', 'absent actual packet never earns posted-actual display');
      assert.equal(bill.displayAmountTrust, priorBill.confidence === 'estimated' ? 'estimated'
        : priorBill.confidence === 'confirmed' ? 'calculated' : null,
      'schedule display retains the immutable input confidence');
      delete bill.displayAmountBasis; delete bill.displayAmountTrust;
    }
    delete period.budgetProgress; delete period.budgetProgressAsOf; count++;
  }
  assert.ok(count > 0, 'new namespaces are positively validated before comparison');
  return copy;
}
const inventory = legacyAfter.savingsInventory; delete legacyAfter.savingsInventory;
assert.equal(inventory.status, 'setup-unknown');
let rejectedCostMutations = 0;
for (const field of ['fundingSequence', 'majorPlans']) {
  const mutations = [
    ['changed original cost', row => { row.commitmentCost.originalCost.amount += 1; }],
    ['unconfigured paid promoted to known zero', row => {
      row.commitmentCost.confirmedLinkedPaid = { status: 'known', amount: 0, range: null };
    }],
    ['wrong opening date', row => { row.commitmentCost.asOf = '2000-01-01'; }],
    ['unexpected nested field', row => { row.commitmentCost.originalCost.unexpected = true; }],
    ['missing expected packet', row => { delete row.commitmentCost; }],
  ];
  for (const [name, mutate] of mutations) {
    const changed = clone(legacyAfter);
    mutate(changed[field].find(row => row.id === 'trip-a'));
    assert.throws(() => incumbentPublication(changed), assert.AssertionError, field + ': ' + name);
    rejectedCostMutations++;
  }
  const noncommitment = clone(legacyAfter);
  noncommitment[field].push({ id: 'annual-a', source: 'yearly-card-paid-bill',
    commitmentCost: clone(legacyAfter[field].find(row => row.id === 'trip-a').commitmentCost) });
  assert.throws(() => incumbentPublication(noncommitment), assert.AssertionError,
    field + ': noncommitment row cannot acquire a removable cost namespace');
  rejectedCostMutations++;
  const duplicate = clone(legacyAfter);
  duplicate[field].push(clone(duplicate[field].find(row => row.id === 'trip-a')));
  assert.throws(() => incumbentPublication(duplicate), assert.AssertionError,
    field + ': duplicate native identity cannot be normalized');
  rejectedCostMutations++;
  const missing = clone(legacyAfter);
  missing[field] = missing[field].filter(row => row.id !== 'trip-a');
  assert.throws(() => incumbentPublication(missing), assert.AssertionError,
    field + ': every expected native commitment must publish its packet');
  rejectedCostMutations++;
}
for (const placement of ['root', 'defaultView']) {
  const unexpected = clone(legacyAfter), destination = placement === 'root' ? unexpected : unexpected.defaultView;
  destination.commitmentCost = clone(legacyAfter.fundingSequence.find(row => row.id === 'trip-a').commitmentCost);
  assert.throws(() => sameAsLegacy(incumbentPublication(unexpected), legacyBefore), assert.AssertionError,
    placement + ': unauthorized cost placement remains visible to whole-object equality');
  rejectedCostMutations++;
}
assert.equal(rejectedCostMutations, 18, 'every bounded cost rejection control executed');
sameAsLegacy(incumbentPublication(legacyAfter), legacyBefore, 'every incumbent recommend field is unchanged with absent configuration');
const changedBalance = clone(legacyAfter); changedBalance.binding.balance += 1;
assert.throws(() => sameAsLegacy(incumbentPublication(changedBalance), legacyBefore),
  assert.AssertionError, 'a changed incumbent balance is still detected');
const changedTrust = clone(legacyAfter); changedTrust.defaultView.calendarPeriods[0].afterBillsTrust = 'unavailable';
assert.throws(() => sameAsLegacy(incumbentPublication(changedTrust), legacyBefore),
  assert.AssertionError, 'a changed incumbent trust field is still detected');
const changedPublisher = clone(legacyAfter); changedPublisher.payPeriodViews[0].budgetProgress.source = 'page';
assert.throws(() => incumbentPublication(changedPublisher), assert.AssertionError,
  'an unauthorized new publisher is rejected rather than excluded silently');
const changedDisplayTrust = clone(legacyAfter);
changedDisplayTrust.payPeriodViews.find(p => p.bills.length).bills[0].displayAmountTrust = 'verified';
assert.throws(() => incumbentPublication(changedDisplayTrust), assert.AssertionError,
  'unsupported new display trust is positively rejected before comparison');
const changedDisplayBasis = clone(legacyAfter);
changedDisplayBasis.payPeriodViews.find(p => p.bills.length).bills[0].displayAmountBasis = 'posted-actual';
assert.throws(() => incumbentPublication(changedDisplayBasis), assert.AssertionError,
  'invented posted-actual provenance without a packet is rejected before comparison');
const changedBillsPublisher = clone(legacyAfter);
changedBillsPublisher.defaultView.billsAccountPeriodBalance.source = 'page';
assert.throws(() => incumbentPublication(changedBillsPublisher), assert.AssertionError,
  'the added Bills publisher is validated before its namespace is excluded');
const falseBillsReady = clone(legacyAfter);
Object.assign(falseBillsReady.defaultView.billsAccountPeriodBalance, { status: 'ready', trust: 'estimated', amount: 0 });
assert.throws(() => incumbentPublication(falseBillsReady), assert.AssertionError,
  'a ready Bills figure without actuals is rejected before comparison');
const unexpectedBillsNamespace = clone(legacyAfter);
unexpectedBillsNamespace.unexpected = { billsAccountPeriodBalance: clone(legacyAfter.defaultView.billsAccountPeriodBalance) };
assert.throws(() => incumbentPublication(unexpectedBillsNamespace), assert.AssertionError,
  'the addition cannot hide fields outside its three authorized publication paths');
empty.savingsEarmarks = { version: 1, currency: 'CAD', pools: [], history: [] };
const explicitEmpty = F.recommend(empty, AS_OF, opts); delete explicitEmpty.savingsInventory;
sameAsLegacy(incumbentPublication(explicitEmpty), require('./bad-full-load-legacy').frozen(before.recommend(empty, AS_OF, opts)), 'explicitly empty configuration also preserves every incumbent field');
console.log('PASS immutable before/after against ' + BASE + ': missing inventory and unsafe incremental instruction reproduced; configured reconciliation/withholding proved; complete incumbent recommend preserved when absent or empty');
console.log('PASS bounded commitmentCost acceptance: exactly six positively validated additions; 18 rejection controls; immutable baseline and incumbent assertions preserved');
