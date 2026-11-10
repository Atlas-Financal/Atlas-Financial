'use strict';
/* Debt absorption must cover the cash walk it governs. All fixtures are
 * synthetic; expected payments are literal dates, counts, or direct sums.
 * No production scheduler, debt walker, or cap solver computes expectations.
 * Run: node test/test-debt-absorption-horizon.js
 */
const F = require('../public/forecast.js');

let failures = 0;
const ok = (condition, label) => {
  if (!condition) failures++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}`);
};
const near = (actual, expected, label) => ok(
  Number.isFinite(actual) && Math.abs(actual - expected) < 0.005,
  `${label}: ${actual} / expected ${expected}`);
const clone = value => JSON.parse(JSON.stringify(value));
const START = '2026-01-01';
const MONTH_ENDS = [
  '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30',
  '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31',
  '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31',
];
function plan(extra) {
  return Object.assign({
    windowDays: 91,
    startingCash: { amount: 1200 },
    defaults: { targetBuffer: 0 },
    income: [], obligations: [], bills: [], commitments: [],
  }, extra || {});
}
function debt(balance, extra) {
  return Object.assign({ id: 'card', label: 'Synthetic card', balance,
    pending: 0, rate: 0, limit: 10000 }, extra || {});
}
function monthly(extra) {
  return Object.assign({ id: 'minimum', label: 'Monthly minimum',
    frequency: 'monthly', day: 31, amount: 100,
    debtId: 'card', effect: 'payment', confidence: 'confirmed' }, extra || {});
}
function recommend(p, debts, extra, asOf = START) {
  return F.recommend(p, asOf, Object.assign({ debts, targetBuffer: 0,
    extraDebtMonthly: 0 }, extra || {}));
}
// Read the actual cash result with the recommendation's own absorption caps.
// Expected values below never come from this helper.
function zeroWalk(p, advice, asOf = START) {
  return F.simulate(p, asOf, Object.assign({}, advice.simOptions, {
    weeklyVariable: 0, horizonDays: advice.knowledge.days,
    viewDays: advice.knowledge.days, viewStart: asOf,
  }));
}

console.log('=== monthly debt across 91-day and 365-day horizons ===');
{
  const p = plan({ obligations: [monthly()] });
  const debts = [debt(1200)];
  const before = JSON.stringify({ p, debts });
  const result = recommend(p, debts);
  const full = zeroWalk(p, result);
  // Twelve $100 obligations consume exactly $1,200. Any positive weekly
  // spend is infeasible; $15/week from only three payments is false slack.
  near(result.weekly, 0, 'all opening cash belongs to the twelve minimums');
  near(full.totals.obligations, 12 * 100, 'full-horizon recurring deductions');
  near(result.knowledge.ending, 0, 'recommended master cash closes at zero');
  near(result.knowledge.freeCash, 0, 'no invented master surplus');
  ok(full.events.filter(e => e.kind === 'obligation').map(e => e.date).join(',')
    === MONTH_ENDS.join(','), 'monthly dates clamp to every actual month end');
  near(result.sim.totals.obligations, 3 * 100, '91-day visible slice has three payments');
  near(result.sim.ending, 1200 - 3 * 100, '91-day cash retains later obligations as future cash');
  ok(JSON.stringify({ p, debts }) === before, 'recommendation leaves inputs unchanged');

  const defaultDebtWalk = F.projectDebts(p, debts, START);
  ok(defaultDebtWalk.end === '2026-04-01', 'public default debt walk remains 91 days');
  near(defaultDebtWalk.byId.card.paid, 300, 'default debt projection keeps its existing span');
  const shortOverride = recommend(p, debts, { debtHorizonDays: 7 });
  near(zeroWalk(p, shortOverride).totals.obligations, 1200,
    'a caller debt-display override cannot truncate recommendation absorption');

  for (const days of [7, 91, 365]) {
    const view = recommend(p, debts, { viewDays: days });
    near(view.weekly, 0, `${days}-day view has the same weekly answer`);
    near(view.knowledge.ending, 0, `${days}-day view has the same master ending`);
  }
  const custom = recommend(p, debts, {
    view: { start: '2026-04-01', end: '2026-04-30' },
  });
  near(custom.sim.totals.obligations, 100, 'April offset view includes April minimum');
  near(custom.sim.ending, 1200 - 4 * 100, 'April closes after all four payments');
  const widePlan = plan({ windowDays: 365, obligations: [monthly()] });
  near(recommend(widePlan, debts).knowledge.ending, 0,
    '91-day versus 365-day plan display does not change the master answer');
}

console.log('\n=== exact inclusive boundaries and longer knowledge ===');
{
  // Offsets 90 / 91 / 364 / 365 from 1 Jan 2026. A 91-day span
  // includes Apr 1; a 365-day span includes Dec 31 but not next Jan 1.
  const dates = ['2026-04-01', '2026-04-02', '2026-12-31', '2027-01-01'];
  const p = plan({ startingCash: { amount: 1000 }, obligations: dates.map((date, i) =>
    monthly({ id: 'edge-' + i, frequency: 'once', date, amount: 10 })) });
  const result = recommend(p, [debt(1000)]);
  const full = zeroWalk(p, result);
  near(result.zero.totals.obligations, 10, 'short opening walk includes only offset 90');
  near(full.totals.obligations, 30, 'long walk includes offsets 90, 91 and 364 exactly once');
  near(full.ending, 1000 - 3 * 10, 'boundary cash independently reconciles');
  ok(full.events.filter(e => e.kind === 'obligation').map(e => e.date).join(',')
    === dates.slice(0, 3).join(','), 'offset 365 is not invented inside the year');

  const extended = plan({ startingCash: { amount: 1400 }, obligations: [monthly()],
    commitments: [{ id: 'far', label: 'Dated cost', date: '2027-02-01', amount: 100 }] });
  const farther = recommend(extended, [debt(2400)]);
  ok(farther.knowledge.days === 397 && farther.knowledge.end === '2027-02-01',
    'a later dated commitment extends knowledge to 397 days');
  near(zeroWalk(extended, farther).totals.obligations, 13 * 100,
    'absorption includes thirteen month ends when knowledge exceeds a year');
  near(farther.knowledge.ending, 1400 - 1300 - 100, 'extended cash pays debt plus dated cost');
}

console.log('\n=== mortgage cadence, partial payoff and final obligations ===');
{
  const p = plan({ startingCash: { amount: 5400 }, obligations: [monthly({
    id: 'mortgage-payment', debtId: 'mortgage', frequency: 'biweekly',
    anchor: START, amount: 200,
  })] });
  const debts = [debt(10000, { id: 'mortgage', secured: true,
    rate: 12, interestByEvent: true, principalShare: 0.5 })];
  const result = recommend(p, debts);
  near(result.sim.totals.obligations, 7 * 200, 'seven fortnightly mortgage payments inside 91 days');
  near(zeroWalk(p, result).totals.obligations, 27 * 200,
    'offsets 0 through 364 every fourteen days give 27 mortgage payments');
  near(result.knowledge.ending, 0, 'full mortgage cash is deducted');
  const projected = F.projectDebts(p, debts, START, { debtHorizonDays: 365 });
  near(projected.byId.mortgage.balance, 10000 - 27 * 100, 'mortgage principal receives half each payment');
  near(projected.byId.mortgage.interest, 27 * 100, 'mortgage interest is absorbed once, without daily duplication');
}
{
  const p = plan({ startingCash: { amount: 350 }, obligations: [monthly()] });
  const debts = [debt(350), debt(1000, { id: 'other' })];
  const result = recommend(p, debts);
  const events = zeroWalk(p, result).events.filter(e => e.kind === 'obligation');
  ok(events.map(e => -e.amount).join(',') === '100,100,100,50',
    'partial final April minimum absorbs only the remaining $50');
  ok(events[3] && events[3].date === '2026-04-30', 'final partial payment survives past day 91');
  near(result.knowledge.ending, 0, 'no deductions after payoff and no cash lost to unabsorbed minimums');
  const projected = F.projectDebts(p, debts, START, { debtHorizonDays: 365 });
  near(projected.byId.other.balance, 1000, 'scheduled minimums never spill into another debt');

  const finalPlan = plan({ startingCash: { amount: 80 }, obligations: [monthly({
    id: 'final', frequency: 'once', date: '2026-05-10', amount: 80,
  })] });
  const final = recommend(finalPlan, [debt(80)]);
  near(zeroWalk(finalPlan, final).totals.obligations, 80, 'declared final once payment is deducted once');
  const later = recommend(finalPlan, [debt(80)], {}, '2026-05-11');
  const carried = zeroWalk(finalPlan, later, '2026-05-11');
  near(carried.totals.obligations, 80, 'advancing observation does not settle an unpaid final payment');
  ok(carried.events.filter(e => e.id === 'final').length === 1
    && carried.events.find(e => e.id === 'final').date === '2026-05-10',
  'carried final payment retains its date and does not become recurring');
}

console.log('\n=== represented, prepaid and carried observation boundaries ===');
{
  // Dated opening: cash already excludes the prepaid May outflow ($1,100
  // not $1,200). Opening debt does not yet include that principal
  // reduction ($1,200). Cash omits May once; the coupled debt walk still
  // applies it. Live-advanced openings overlay posted debt and omit here.
  const p = plan({ startingCash: { amount: 1100 }, obligations: [monthly()],
    opening: { asOf: START, representedEvents: [{ id: 'minimum', date: '2026-05-31' }] } });
  const result = recommend(p, [debt(1200)]);
  const full = zeroWalk(p, result);
  near(full.totals.obligations, 11 * 100, 'prepaid May occurrence is not deducted again');
  ok(!full.events.some(e => e.id === 'minimum' && e.date === '2026-05-31'),
    'future representation suppresses only its exact occurrence');
  near(result.knowledge.ending, 0, 'prepaid opening cash and debt reconcile');

  const represented = plan({ startingCash: { amount: 1100 }, obligations: [monthly()],
    opening: { asOf: '2026-01-31', representedEvents: [{ id: 'minimum', date: '2026-01-31' }] } });
  const sameDay = recommend(represented, [debt(2000)], {}, '2026-01-31');
  near(zeroWalk(represented, sameDay, '2026-01-31').totals.obligations, 11 * 100,
    'same-day represented January payment leaves February through December');

  const moved = plan({ startingCash: { amount: 1300 }, obligations: [monthly({ firstDue: '2026-03-31' })],
    opening: { priorAsOf: '2026-03-30', asOf: '2026-04-03' } });
  const later = recommend(moved, [debt(2000)], {}, '2026-04-03');
  const carried = zeroWalk(moved, later, '2026-04-03');
  near(carried.totals.obligations, 13 * 100,
    'later observation includes unresolved March plus April through next March');
  ok(carried.events.filter(e => e.date === '2026-03-31').length === 1,
    'carried recurring occurrence appears once with original date');
  const settled = clone(moved);
  settled.startingCash.amount = 1200;
  settled.opening.representedEvents = [{ id: 'minimum', date: '2026-03-31' }];
  const afterPosting = recommend(settled, [debt(1900)], {}, '2026-04-03');
  near(zeroWalk(settled, afterPosting, '2026-04-03').totals.obligations, 12 * 100,
    'represented carried payment leaves exactly twelve future occurrences');
}

console.log('\n=== extra payments, recovery and incumbent cash reserves ===');
{
  const p = plan();
  const result = recommend(p, [debt(1200)], { extraDebtMonthly: 100, extraDebtTarget: 'card' });
  near(zeroWalk(p, result).totals.extra, 12 * 100, 'twelve declared monthly extras survive beyond day 91');
  near(result.knowledge.ending, 0, 'extra-payment absorption does not create spendable phantom cash');
  const paidOff = recommend(p, [debt(350)], { extraDebtMonthly: 100, extraDebtTarget: 'card' });
  near(zeroWalk(p, paidOff).totals.extra, 350, 'extras stop after the fourth partial payment');

  const recovery = plan({ startingCash: { amount: 0 }, obligations: [monthly()],
    income: [{ id: 'later-pay', label: 'Later pay', frequency: 'once', date: '2026-04-15', amount: 1500 }] });
  const recovered = recommend(recovery, [debt(1200)], {
    fundingSources: [{ id: 'held-cash', label: 'Held household cash', available: 1200 }],
  });
  near(recovered.funding.allocated, 300, 'opening recovery still covers only three visible minimums');
  near(zeroWalk(recovery, recovered).totals.obligations, 1200,
    're-measured recovery caps cover the whole year');
  near(zeroWalk(recovery, recovered).ending, 300 + 1500 - 1200,
    'recovery cash plus later income less all minimums reconciles');
}
{
  const p = plan({ startingCash: { amount: 2000 }, obligations: [monthly()],
    budget: { categories: [{ id: 'service', currentMonthly: 10 }] },
    bills: [{ id: 'card-service', label: 'Card-paid service', frequency: 'monthly', day: 15,
      amount: 20, payingAccount: 'card' }],
    commitments: [
      { id: 'dated', label: 'Dated need', date: '2026-12-01', amount: 200 },
      { id: 'undated', label: 'Undated need', amount: 100 },
    ] });
  const unresolved = recommend(p, [debt(1200)]);
  ok(unresolved.weekly === null && unresolved.knowledge.ending === null && unresolved.holds === null,
    'original required-undated price withholds dependent cash and spending claims');
  ok(p.commitments[1].amount === 100 && p.commitments[1].date === undefined,
    'the original known price remains undated');
  // Separate invented dated cash ledger: the 100 is paid on Dec 31.
  const dated = clone(p); dated.commitments[1].date = '2026-12-31';
  const result = recommend(dated, [debt(1200)]);
  const full = zeroWalk(dated, result);
  const reserve = 10 * 12 * 365 / 365.25 + 20 * 12;
  near(full.totals.obligations, 1200, 'cash reserves do not replace debt obligations');
  near(full.totals.reserved, reserve, 'daily current-regime and monthly card-paid reserve remain once each');
  near(full.totals.commitments, 200 + 100, 'two stated dated future costs each move once');
  near(result.knowledge.encumbered, 0, 'dated costs are paid in the walk, never also reserved as undated principal');
  near(result.knowledge.ending, 2000 - 1200 - 200 - 100 - reserve, 'all independent dated cash deductions reconcile');
  near(result.knowledge.freeCash, 2000 - 1200 - 200 - reserve - 100,
    'future debt and reserves jointly constrain residual cash');
  near(result.weekly, 0, '$5/week would exceed the remaining protected cash');
  ok(result.holds, 'the zero-spend protected plan remains feasible');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exitCode = failures ? 1 : 0;
