'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const F = require('../public/forecast');
const { AS_OF, fixture, clone } = require('./fixtures/savings-funding-timeline');
const options = { weeklyVariable: 35 };
const before = fs.readFileSync('data.json');
const cents = value => Math.round(value * 100);
const p = fixture(), input = JSON.stringify(p);
const timeline = F.savingsFundingTimeline(p, [], AS_OF, options);
assert.equal(timeline.status, 'ready', timeline.reason);
assert.equal(JSON.stringify(p), input, 'no household input or confirmation mutation');
assert.equal(timeline.actionPermission, 'not-granted');
assert.equal(timeline.incrementalInstructions, 'withheld');
assert.equal(timeline.actualContributions, null);
assert.equal(timeline.trust, 'estimated');
assert.equal(timeline.completeness, 'partial', 'undated known need is disclosed');
assert.ok(timeline.goals.every(goal => goal.actualSaved === null && goal.actualContribution === null));
assert.equal(timeline.payments.filter(payment => payment.id === 'club-first').length, 1);
assert.equal(timeline.payments.filter(payment => payment.id === 'annual-a').length, 1);
assert.ok(!timeline.payments.some(payment => payment.id === 'undated-a'));

// Independent cents ledger: 90 opening, 500 every fourteen days, 5 daily,
// 30 required on each 18th, 25 ordinary bill on each 20th, 80/200 camps,
// 70 annual card-paid planning cost. None of these expected numbers are
// obtained from Forecast output or a Forecast event-expansion function.
let native = 9000;
for (let i = 0; i < timeline.daily.length; i++) {
  const row = timeline.daily[i], day = Number(row.date.slice(8, 10));
  if (i % 14 === 0) native += 50000;
  if (day === 18) native -= 3000;
  if (day === 20) native -= 2500;
  if (row.date === '2026-09-15') native -= 8000;
  if (row.date === '2026-09-25') native -= 7000;
  if (row.date === '2026-10-12') native -= 20000;
  native -= 500;
  assert.equal(cents(row.nativeOperating), native, 'independent native close ' + row.date);
  assert.equal(cents(row.combined), native + 8000, 'both pools counted once ' + row.date);
  assert.equal(cents(row.operating) + row.pools.reduce((sum, pool) => sum + cents(pool.amount), 0), native + 8000);
  assert.equal(row.reconciliationDelta, 0);
}
const first = timeline.payPeriods[0];
assert.equal(first.normalResidual, 375, '500 income less 70 groceries, 30 required and 25 bill');
assert.equal(first.afterKnownDeductions, 295, '80 planned draw deducted once');
assert.equal(first.contribution, 310, '70 advance + 40 home + 200 future camp');
assert.equal(first.plannedDraws, 80);
assert.equal(first.operatingClose, 155);
assert.deepEqual(first.pools.map(pool => [pool.opening, pool.contribution, pool.draws, pool.closing]),
  [[50, 270, 80, 240], [30, 40, 0, 70]]);
assert.equal(first.goals.find(goal => goal.key === 'group:camp-a').projectedContribution, 270, 'grouped proposal is Forecast-owned');
const undated = first.goals.find(goal => goal.key === 'commitment:undated-a');
assert.equal(undated.projectedContribution, null, 'unsupported dated component is unknown, never a zero proposal');
assert.equal(undated.trust, 'unknown');
const clipped = timeline.payPeriods.at(-1);
assert.notEqual(clipped.end, clipped.cycleEnd);
assert.ok(!timeline.transfers.some(t => t.date === clipped.end && t.timing === 'pay-period-close'), 'clipped cycle has no close allocation');
for (const period of timeline.payPeriods) {
  assert.equal(cents(period.contribution), period.pools.reduce((sum, pool) => sum + cents(pool.contribution), 0));
  for (const pool of period.pools) assert.equal(cents(pool.closing), cents(pool.opening) + cents(pool.contribution) - cents(pool.draws));
  for (const goal of period.goals) assert.equal(goal.actualContribution, null);
}
assert.ok(timeline.daily.every(row => row.pools[0].amount >= 40), 'undated known requirement stays protected');
assert.ok(timeline.transfers.every(t => t.trust === 'estimated' && t.actionPermission === 'not-granted'));
const rangedPlan = fixture(); delete rangedPlan.commitments[1].amount;
rangedPlan.commitments[1].amountMin = 200; rangedPlan.commitments[1].amountMax = 240;
const ranged = F.savingsFundingTimeline(rangedPlan, [], AS_OF, options);
assert.equal(ranged.status, 'ready', ranged.reason);
assert.equal(ranged.payPeriods[0].goals.find(goal => goal.key === 'group:camp-a').projectedContribution, null,
  'a lower-bound dated payment cannot establish the full ranged proposal');
assert.equal(timeline.payPeriods[1].goals.find(goal => goal.key === 'yearly-bill:annual-a').projectedContribution, 0,
  'a complete dated requirement can establish a genuine zero contribution');

// Changing the supplied operating opening changes projection cash, never
// silently reusing a prior Bills balance or absorbing silver a second time.
const lower = fixture(); lower.startingCash.breakdown[0].value -= 17.29;
const lowered = F.savingsFundingTimeline(lower, [], AS_OF, options);
assert.equal(cents(timeline.daily[0].combined) - cents(lowered.daily[0].combined), 1729);
const increased = fixture(); increased.savingsPoolObservation.accounts[0].value += 13.17;
const more = F.savingsFundingTimeline(increased, [], AS_OF, options);
assert.equal(cents(more.daily[0].combined) - cents(timeline.daily[0].combined), 1317, 'observed-pool increase counted once');

for (const [name, edit] of [
  ['stale pool', q => q.savingsPoolObservation.accounts[0].evidenceDate = '2026-09-09'],
  ['missing pool', q => q.savingsPoolObservation.accounts.pop()],
  ['pending pool', q => q.savingsPoolObservation.accounts[0].pendingState = 'unknown'],
  ['malformed observation', q => q.savingsPoolObservation.accounts.push(null)],
  ['duplicate pool observation', q => q.savingsPoolObservation.accounts.push(clone(q.savingsPoolObservation.accounts[0]))],
  ['conflicting currency', q => q.savingsPoolObservation.accounts[0].currency = 'USD'],
  ['old operating opening', q => q.opening.asOf = '2026-09-09'],
  ['unknown requirement', q => delete q.commitments[0].amount],
  ['ambiguous pool goal', q => q.savingsEarmarks.pools[1].goalRefs.push({ kind: 'group', id: 'camp-a' })],
  ['confirmed intent', q => q.savingsEarmarks.history.push({ revision: 1, confirmedAt: AS_OF, source: 'Synthetic confirmation', pools: [] })],
]) {
  const q = fixture(); edit(q);
  const result = F.savingsFundingTimeline(q, [], AS_OF, options);
  assert.equal(result.status, 'unavailable', name);
  assert.equal(result.payPeriods.length, 0, name + ' does not fabricate zero figures');
}
const gap = fixture(); gap.startingCash.breakdown[0].value = 0;
gap.income[0].amount = 5; gap.savingsPoolObservation.accounts[0].value = 1;
const failed = F.savingsFundingTimeline(gap, [], AS_OF, options);
assert.ok(failed.fundingGaps.length && failed.daily.some(row => row.operating < 0), 'real deficit remains visible');
assert.equal(failed.actionPermission, 'not-granted');

// Independently invented observations use the existing authenticated overlay
// path. An uncovered card purchase is protected separately from buffer cash.
const Live = require('../scripts/live-plan');
const cardFixture = require('./fixtures/card-purchase-coverage-data');
const observed = Live.fromObservation(cardFixture()).data;
const cardPlan = fixture();
cardPlan.opening = clone(observed.plan.opening);
cardPlan.startingCash = clone(observed.plan.startingCash);
cardPlan.startingCash.breakdown.find(row => row.id === 'savings').value = 50;
cardPlan.startingCash.heldElsewhere = clone(p.startingCash.heldElsewhere);
cardPlan.savingsEarmarks.pools[1].reconciledOn = observed.plan.opening.asOf;
cardPlan.cardPurchaseCoverage = clone(observed.plan.cardPurchaseCoverage);
cardPlan.savingsPoolObservation.asOf = observed.plan.opening.asOf;
cardPlan.savingsPoolObservation.accounts.forEach(row => { row.evidenceDate = observed.plan.opening.asOf; });
const cardOptions = { ...options, debts: observed.debts, currentPeriodActuals: observed.liveOverlay.currentPeriodActuals };
const held = F.savingsFundingTimeline(cardPlan, observed.debts, observed.plan.opening.asOf, cardOptions);
assert.equal(held.status, 'ready', held.reason);
assert.equal(held.assumptions.protectedOperatingFloor, 100, '20 buffer plus independently known 80 card purchase');
delete cardPlan.cardPurchaseCoverage;
assert.equal(F.savingsFundingTimeline(cardPlan, observed.debts, observed.plan.opening.asOf, cardOptions).status, 'unavailable', 'unknown purchase purpose cannot free cash');

// The owner's end-February timing is a conditional projection only. Inputs
// below are invented; expected income amounts are not household fixtures.
function bonusFixture() {
  const q = fixture(); q.income[0].label = 'Synthetic Seaspan payroll';
  q.payrollPlanningAssumptions = { salaryRaiseFactor: 1.011, bonusRate: 0.061,
    authorizedThroughYear: 2027, trust: 'estimated', provenance: 'owner-stated' };
  q.commitments.push({ id: 'winter-a', label: 'Synthetic winter cost', date: '2027-01-21', amount: 950,
    confidence: 'confirmed', sinkingFund: true });
  q.commitments.push({ id: 'later-a', label: 'Synthetic later horizon', date: '2028-02-15', amount: 75,
    confidence: 'confirmed', sinkingFund: false });
  q.savingsEarmarks.pools[0].goalRefs.push({ kind: 'commitment', id: 'winter-a' });
  return q;
}
const bonusPlan = bonusFixture(), noBonusPlan = clone(bonusPlan);
noBonusPlan.payrollPlanningAssumptions.bonusRate = 0;
const withBonus = F.savingsFundingTimeline(bonusPlan, [], AS_OF, options);
const noBonus = F.savingsFundingTimeline(noBonusPlan, [], AS_OF, options);
assert.equal(withBonus.status, 'ready', withBonus.reason);
assert.equal(noBonus.status, 'ready', noBonus.reason);
assert.equal(withBonus.assumptions.bonus.date, '2027-02-28');
assert.equal(withBonus.assumptions.bonus.trust, 'estimated');
assert.equal(withBonus.horizon.end, '2027-12-31', 'unsupported later payroll is withheld');
for (const row of withBonus.daily.filter(row => row.date < '2027-02-28')) {
  const without = noBonus.daily.find(other => other.date === row.date);
  assert.equal(row.combined, without.combined, 'future bonus cannot fund earlier cash ' + row.date);
}
assert.deepEqual(withBonus.transfers.filter(t => t.date < '2027-02-28'), noBonus.transfers.filter(t => t.date < '2027-02-28'));
assert.equal(cents(withBonus.daily.find(row => row.date === '2027-02-28').combined)
  - cents(noBonus.daily.find(row => row.date === '2027-02-28').combined), cents(withBonus.assumptions.bonus.amount));
const legacyBonus = clone(bonusPlan);
legacyBonus.income.push({ id: 'payrollBonus', label: 'Synthetic Seaspan bonus', frequency: 'once',
  date: '2027-02-25', amount: 123, confidence: 'estimated' });
assert.deepEqual(F.savingsFundingTimeline(legacyBonus, [], AS_OF, options).daily, withBonus.daily,
  'legacy estimated bonus is replaced once, never duplicated');
legacyBonus.income.at(-1).confidence = 'confirmed';
assert.equal(F.savingsFundingTimeline(legacyBonus, [], AS_OF, options).status, 'unavailable', 'confirmed deposit is not retimed');

// Real publication path and legacy safety: all prior baseline fields stay
// identical against immutable merged main. Projection is a separate packet.
const base = { module: { exports: {} }, console };
vm.runInNewContext(execFileSync('git', ['show', 'b754ae1901609fce4b49a1bb3e0ad14ea17d1427:public/forecast.js'], { encoding: 'utf8' }), base);
// Required operating values are checked before any zero-coercing aggregate.
// Conservation alone cannot detect a fabricated opening on both ledger sides.
const cashCases = [
  ['missing cash object', q => delete q.startingCash],
  ['null cash object', q => q.startingCash = null],
  ['string cash object', q => q.startingCash = 'unknown'],
  ['array cash object', q => q.startingCash = Object.assign([], q.startingCash)],
  ['missing breakdown key', q => delete q.startingCash.breakdown],
  ['null breakdown', q => q.startingCash.breakdown = null],
  ['malformed breakdown', q => q.startingCash.breakdown = {}],
  ['empty breakdown', q => q.startingCash.breakdown = []],
  ['both operating accounts absent', q => q.startingCash.breakdown = q.startingCash.breakdown.filter(row => row.id === 'savings')],
  ...['chequing-a', 'chequing-b'].flatMap(id => [
    [id + ' absent', q => q.startingCash.breakdown = q.startingCash.breakdown.filter(row => row.id !== id)],
    [id + ' missing value', q => delete q.startingCash.breakdown.find(row => row.id === id).value],
    ...[null, undefined, '0', '23.45', 'unknown', NaN, Infinity, -Infinity, false, 0.001].map(value =>
      [id + ' invalid ' + String(value), q => q.startingCash.breakdown.find(row => row.id === id).value = value]),
    [id + ' duplicate', q => q.startingCash.breakdown.push(clone(q.startingCash.breakdown.find(row => row.id === id)))],
  ]),
];
for (const [name, edit] of cashCases) {
  const q = fixture(); edit(q);
  const result = F.savingsFundingTimeline(q, [], AS_OF, options);
  assert.equal(result.status, 'unavailable', name);
  assert.match(result.reason, /operating accounts/);
  assert.deepEqual(result.daily, [], name + ' publishes no fabricated cash ledger');
  assert.deepEqual(result.payPeriods, [], name + ' publishes no fabricated contribution');
  assert.equal(result.actualContributions, null);
  assert.equal(result.actionPermission, 'not-granted');
  // The legacy aggregate is deliberately not changed in this narrow repair.
  // Where its input shape is supported, all incumbent baseline fields remain
  // identical; malformed shapes retain the same legacy failure outside here.
  if (q.startingCash?.breakdown && !Array.isArray(q.startingCash.breakdown)) continue;
  // A present household chequing row with no numeric evidence is Unknown
  // (ATLAS-078 rulings A/B; Forecast.openingCashState). The legacy engine
  // counted it as $0 and published a calculated trajectory from that seed;
  // the stricter contract replaces parity for exactly these cases: the
  // spendable figure is Unknown and the trajectory is unavailable, never
  // the $0-seeded months. Every other shape keeps exact legacy parity.
  if (Array.isArray(q.startingCash?.breakdown) && F.openingCashState(q).status === 'unavailable') {
    assert.equal(F.spendableHouseholdCash(q), null, name + ' spendable household cash is Unknown');
    const unknownPublication = F.baselineTrajectory(q, [], AS_OF, options);
    assert.equal(unknownPublication.status, 'unavailable', name + ' trajectory is unavailable, not $0-seeded');
    assert.match(unknownPublication.reason, /chequing opening balance is unknown/, name + ' names the unknown opening');
    assert.equal(base.module.exports.baselineTrajectory(q, [], AS_OF, options).status, 'ready',
      name + ' legacy engine published a $0-seeded trajectory here (the defect replaced)');
    continue;
  }
  assert.equal(Object.is(F.startingCashAmount(q), base.module.exports.startingCashAmount(q)), true, name + ' incumbent cash helper unchanged');
  const oldPublication = base.module.exports.baselineTrajectory(q, [], AS_OF, options);
  const newPublication = F.baselineTrajectory(q, [], AS_OF, options);
  if (newPublication.savingsFundingTimeline) {
    assert.equal(newPublication.savingsFundingTimeline.status, 'unavailable', name + ' active baseline withholds new packet');
    delete newPublication.savingsFundingTimeline;
  }
  assert.equal(JSON.stringify(newPublication), JSON.stringify(oldPublication), name + ' incumbent publications unchanged');
}
for (const values of [[0, 0], [0, -10], [100, 0], [12.34, -5.67]]) {
  const q = fixture(); q.startingCash.breakdown[0].value = values[0]; q.startingCash.breakdown[1].value = values[1];
  const result = F.savingsFundingTimeline(q, [], AS_OF, options);
  assert.equal(result.status, 'ready', 'explicit zero or valid signed cash stays available: ' + values);
  assert.equal(cents(result.daily[0].combined), cents(values[0]) + cents(values[1]) + 50000 - 500 + 8000,
    'independent valid opening and first daily cash ledger');
  const publication = F.baselineTrajectory(q, [], AS_OF, options);
  assert.deepEqual(publication.savingsFundingTimeline, result);
  delete publication.savingsFundingTimeline;
  assert.equal(JSON.stringify(publication), JSON.stringify(base.module.exports.baselineTrajectory(q, [], AS_OF, options)), 'valid controls preserve incumbent publications');
}
const current = F.baselineTrajectory(p, [], AS_OF, options);
assert.deepEqual(current.savingsFundingTimeline, timeline);
delete current.savingsFundingTimeline;
assert.equal(JSON.stringify(current), JSON.stringify(base.module.exports.baselineTrajectory(p, [], AS_OF, options)));
const bonusBaseline = F.baselineTrajectory(bonusPlan, [], AS_OF, options);
delete bonusBaseline.savingsFundingTimeline;
assert.equal(JSON.stringify(bonusBaseline), JSON.stringify(base.module.exports.baselineTrajectory(bonusPlan, [], AS_OF, options)), 'payroll and bonus changes are private to hypothetical packet');
assert.equal(F.savingsInventory(p, AS_OF).incrementalInstructions, 'withheld', 'projection never earns live transfer instructions');
assert.equal(F.planSpendPaydayFunding(p, AS_OF).status, 'unavailable');
assert.deepEqual(fs.readFileSync('data.json'), before, 'canonical household amounts unchanged');
console.log('PASS: savings funding timeline independent daily/period conservation, grouped proposals, unknown actuals and fail-closed safety');
