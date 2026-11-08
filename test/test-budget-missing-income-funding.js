'use strict';
// Synthetic Budget fixture and independent ledger arithmetic. These are not
// household balances, an original payday allocation, or actual saved funds.
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const fixture = require('./fixtures/budget-funding-data');
const cents = n => Math.round(n * 100);
const period = (advice, start) => advice.payPeriodViews.find(p => p.start === start);

function state(bonusRate = .18, bonusBase = null, bonusDate = '2027-02-25') {
  const data = fixture();
  data.meta.asOf = data.plan.opening.asOf = '2026-12-18';
  data.plan.bills.pop();
  data.plan.commitments[0].date = '2027-01-14';
  data.plan.payrollPlanningAssumptions = {
    salaryRaiseFactor: 1.04, bonusRate, authorizedThroughYear: 2027,
  };
  if (bonusBase != null) data.plan.income.push({ id: 'payrollBonus',
    label: 'Payroll bonus — Seaspan', frequency: 'once', date: bonusDate,
    amount: bonusBase, confidence: 'confirmed' });
  return data;
}
const run = (data, opts = {}) => F.recommend(data.plan, data.meta.asOf, opts);
// Independently reconciled regime example: 28456.38 gross bonus less
// 11581.75 tax, 1693.15 CPP and 463.84 EI = 14717.64 net. The first four
// regular cheques are 3849.40; the fixture supplies 200 bills + 300 allowance.
const BONUS = 28456.38 - 11581.75 - 1693.15 - 463.84;
const REGULAR = 3849.40;
const missing = state();
const before = JSON.stringify(missing);
const advice = run(missing);
assert.equal(period(advice, '2027-01-01').plannedCostFunding.contribution, 600,
  'a later missing-stream bonus must not withhold the earlier January proposal');
function assertBonusPeriod(a, bonus, label) {
  const feb = period(a, '2027-02-12');
  const hits = feb.income.filter(r => r.id === 'payrollBonus' && r.date === '2027-02-25');
  assert.equal(hits.length, 1, label + ': one published bonus row, including the zero estimate');
  assert.equal(cents(hits[0].amount), cents(bonus), label + ': exact published bonus');
  assert.equal(cents(feb.incomeTotal), cents(REGULAR) + cents(bonus), label + ': independent income sum');
  assert.equal(cents(feb.plannedCostFunding.capacity), cents(REGULAR) + cents(bonus) - 20000 - 30000,
    label + ': independent income minus bill and allowance, bonus counted once');
  assert.equal(feb.plannedCostFunding.trust, 'estimated', label + ': estimated income remains estimated');
  assert.equal(feb.plannedCostFunding.contribution, 0, label + ': January cost already funded');
  assert.equal(feb.plannedCostFunding.actualSaved, null);
  assert.equal(feb.plannedCostFunding.originalPaydayPlan, null);
  if (bonus) assert.equal(hits[0].confidence, 'estimated');
  for (const p of a.payPeriodViews.filter(p => p.start >= '2027-01-01')) {
    assert.equal(p.plannedCostFunding.status, 'ready', label + ': full horizon reconciles at ' + p.start);
    assert.equal(cents(p.plannedCostFunding.capacity), cents(p.incomeTotal) - 20000 - 30000,
      label + ': no missing or doubled occurrence at ' + p.start);
  }
}
assertBonusPeriod(advice, BONUS, 'missing stream');
assert.equal(JSON.stringify(missing), before, 'income adapter does not mutate the plan');
assert.deepEqual(run(missing).payPeriodViews, advice.payPeriodViews, 'repeat calls cannot accumulate events');
assertBonusPeriod(run(state(0)), 0, 'zero bonus');
for (const base of [100, 0]) {
  const control = run(state(.18, base));
  assertBonusPeriod(control, BONUS, 'existing stream base ' + base);
  assert.deepEqual(control.payPeriodViews.map(p => p.plannedCostFunding),
    advice.payPeriodViews.map(p => p.plannedCostFunding), 'ordinary stream and missing stream reconcile identically');
}
// The same id on another date is not this occurrence. Both paths must remain
// date-specific; an id-only stream check would drop the estimated Feb 25 row.
assertBonusPeriod(run(state(.18, 0, '2027-03-25')), BONUS, 'stream with different occurrence date');
// Caller-supplied copies are already in the Budget printer's occurrence map.
// Recompose that map rather than concatenating them with the estimated row.
const supplied = { kind: 'income', id: 'payrollBonus', date: '2027-02-25',
  label: 'Payroll bonus — Seaspan', amount: 100, confidence: 'confirmed' };
const duplicated = run(state(), { additionalIncomeEvents: [supplied, { ...supplied }] });
assertBonusPeriod(duplicated, BONUS, 'duplicate supplied occurrences');
assert.deepEqual(duplicated.payPeriodViews.map(p => p.plannedCostFunding),
  advice.payPeriodViews.map(p => p.plannedCostFunding), 'supplied duplicates cannot add funding capacity');

// A bonus already in opening cash cannot be replayed. Exercise current-tail
// settlement through recommend, with and without an ordinary bonus stream.
for (const base of [null, 100, 0]) {
  const settled = state(.18, base);
  settled.meta.asOf = settled.plan.opening.asOf = '2027-02-25';
  settled.plan.opening.representedEvents = [{ id: 'payrollBonus', date: '2027-02-25' }];
  settled.plan.startingCash.breakdown[0].value = 800;
  settled.plan.commitments[0].date = '2027-03-11';
  const opts = { currentPeriodActuals: {
    schema: 'atlas-current-period-actuals/v1', observationAsOf: '2027-02-25',
    coverageStart: '2027-02-12', coverageThrough: '2027-02-25',
    transactionCoverage: 'complete', pendingCoverage: 'complete', transactions: [],
    representedActuals: [{ id: 'payrollBonus', date: '2027-02-25', actual: 700 }],
  } };
  const s = run(settled, opts);
  const current = period(s, '2027-02-12');
  assert.equal(current.plannedCostFunding.contribution, null, 'original current-period plan stays unknown');
  assert.equal(current.plannedCostFunding.actualSaved, null);
  const rows = current.income.filter(r => r.id === 'payrollBonus');
  assert.equal(rows.length, base > 0 ? 1 : 0, 'missing/zero stream cannot resurrect settled estimate');
  assert.ok(rows.every(r => r.amount === 700 && r.settlement === 'represented'),
    'settled bonus never reappears as an estimated deposit');
  const next = period(s, '2027-02-26');
  assert.equal(next.plannedCostFunding.contribution, 600, 'settled current tail permits future funding');
  assert.equal(next.plannedCostFunding.actualSaved, null);
  settled.plan.startingCash.breakdown[0].value = 100;
  const short = period(run(settled, opts), '2027-02-26').plannedCostFunding;
  assert.equal(short.contribution, null, 'settled bonus cannot finance an otherwise-unfunded current tail');
  assert.equal(short.status, 'unavailable');
}

const unknown = state(); unknown.plan.income[0].confidence = 'unknown';
assert.equal(period(run(unknown), '2027-01-01').plannedCostFunding.contribution, null,
  'unknown income trust still withholds funding');

// Posted irregular Other Income has a synthesized display id that is not in
// representedEvents. Its published settlement still proves it is in opening
// cash. 100 opening - 300 remaining groceries = -200 before the next payday;
// replaying the posted 300 would falsely release the next 300 contribution.
for (const cash of [100, 400]) {
  const other = fixture(); other.meta.asOf = other.plan.opening.asOf = '2026-08-20';
  other.plan.startingCash.breakdown[0].value = cash;
  other.plan.commitments[0].amount = 300;
  const opts = { currentPeriodActuals: {
    schema: 'atlas-current-period-actuals/v1', observationAsOf: '2026-08-20',
    coverageStart: '2026-08-14', coverageThrough: '2026-08-20',
    transactionCoverage: 'complete', pendingCoverage: 'complete',
    transactions: [{ id: 'synthetic-other', date: '2026-08-20', amount: -300,
      account: 'chequing-a', accountRole: 'household-cash', categoryLabel: 'Other Income', isIncome: true,
      displayedPayee: 'Synthetic external income', pending: false }],
  } };
  const baseline = run(other, { currentPeriodActuals: { ...opts.currentPeriodActuals, transactions: [] } });
  const a = run(other, opts);
  const received = period(a, '2026-08-14').income.find(r => r.id === 'other-income:synthetic-other');
  assert.equal(received.amount, 300);
  assert.equal(received.settlement, 'represented');
  assert.equal(received.alreadyInCash, true);
  assert.equal(period(a, '2026-08-28').plannedCostFunding.contribution, cash < 300 ? null : 300,
    'represented Other Income cannot repair a short current tail');
  assert.deepEqual(period(a, '2026-08-28').plannedCostFunding,
    period(baseline, '2026-08-28').plannedCostFunding, 'opening cash alone owns already-posted income');
}

console.log('PASS missing-income Budget funding: independent bonus/capacity arithmetic, zero and existing/zero-base streams, occurrence identity, repeat-call deduplication, estimated trust and settlement');
