'use strict';
/* Independent serial funding proof plus the Plan Spend household reprint.
 * The verifier derives constraints from the incumbent cash path and payday
 * anchor. It does not call the allocation producer to calculate an expected
 * answer. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const production = JSON.parse(read('data.json'));
// Keep the incumbent no-earmark allocator proof explicit. Production purpose
// savings intentionally withhold new proposals until the funding path exists;
// the real configured GET/page path is covered by test-purpose-savings.js.
const data = JSON.parse(JSON.stringify(production));
delete data.plan.savingsEarmarks;
const periods = JSON.parse(read('public/periods.json'));
const cent = x => Math.round(Number(x) * 100);
const near = (a, b) => Math.abs(a - b) <= 1;
let checks = 0;
function ok(value, label) { assert.ok(value, label); checks++; }
const configured = F.recommend(production.plan, production.meta.asOf, { debts: production.debts,
  extraFacilities: production.revolvingExtra, periods });
ok(configured.planSpendPaydayFunding.status === 'unavailable', 'configured production withholds incremental funding proposals');
ok(configured.savingsInventory.pools.every(pool => pool.intent === null && pool.unallocated === null),
  'production starting assignments and residual stay unknown, never zero funded');
function isoAdd(date, days) {
  const value = new Date(date + 'T00:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function paydays(anchor, from, through) {
  const result = [];
  const diff = Math.round((Date.parse(from) - Date.parse(anchor)) / 86400000);
  const first = isoAdd(anchor, Math.ceil(diff / 14) * 14);
  for (let date = first; date <= through; date = isoAdd(date, 14)) result.push(date);
  return result;
}
function fixture(pay, need, range) {
  return {
    defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
    opening: { asOf: '2026-01-01' },
    startingCash: { breakdown: [{ id: 'chequing-a', value: 0 }] },
    income: [{ id: 'payroll', label: 'Seaspan', frequency: 'biweekly',
      anchor: '2026-01-02', amount: pay, confidence: 'confirmed' }],
    obligations: [], bills: [], budget: { categories: [] },
    commitments: [range
      ? { id: 'trip', label: 'Trip', date: '2026-01-31',
        amountMin: need, amountMax: need + 40, confidence: 'estimated' }
      : { id: 'trip', label: 'Trip', date: '2026-01-31',
        amount: need, confidence: 'confirmed' }],
  };
}
function synthetic(pay, need, range) {
  const plan = fixture(pay, need, range);
  const asOf = plan.opening.asOf;
  const sim = F.simulate(plan, asOf, { horizonDays: 45, viewDays: 45, weeklyVariable: 0 });
  const seq = F.fundingSequence(plan, asOf);
  return { plan, sim, seq,
    schedule: F.planSpendPaydayFunding(plan, asOf, sim, seq, F.majorPlans(plan, asOf, { weeklyVariable: 0 })) };
}

// A small independent example can be solved by inspection: $150 on 31 Jan,
// with three $100 paydays, needs $50 from 16 Jan and $100 from 30 Jan.
const pulled = synthetic(100, 150, false);
ok(pulled.schedule.status === 'ready', 'synthetic plan is schedulable');
ok(pulled.schedule.paydays.slice(0, 3).map(row => cent(row.contribution)).join(',')
  === '0,5000,10000', 'later $100 capacity pulls $50 into the prior payday');
const late = synthetic(200, 150, false);
ok(late.schedule.paydays.slice(0, 3).map(row => cent(row.contribution)).join(',')
  === '0,0,15000', 'sufficient last-payday capacity demands no earlier saving');
const short = synthetic(40, 150, false);
ok(short.schedule.status === 'funding-gap' && short.schedule.gap
  && cent(short.schedule.gap.shortBy) === 3000
  && short.schedule.gap.cashDate === '2026-01-31',
  'genuine $30 shortfall is published, not called feasible');
const uncertain = synthetic(100, 80, true);
ok(uncertain.schedule.costs[0].baseRequirement === 80
  && uncertain.schedule.costs[0].ceiling === 120
  && uncertain.schedule.costs[0].uncertaintyAdditional === 40,
  'range floor is scheduled and ceiling remains distinct');
ok(!uncertain.sim.events.some(event => event.kind === 'commitment' && event.id === 'trip'),
  'a ranged reserve does not invent a point cash event');
const noSeaspan = synthetic(100, 150, false);
noSeaspan.plan.income[0].id = 'other-pay';
noSeaspan.plan.income[0].label = 'Other income';
ok(F.planSpendPaydayFunding(noSeaspan.plan, noSeaspan.plan.opening.asOf,
  noSeaspan.sim, noSeaspan.seq, []).status === 'unavailable',
  'without a Seaspan identity the schedule fails closed');

// Multiple protected costs before the next payday are one imminent requirement,
// not "affected" labels attached to only the first amount.
const beforePaydayPlan = fixture(100, 100, false);
beforePaydayPlan.opening.asOf = '2026-01-15';
beforePaydayPlan.startingCash.breakdown[0].value = 300;
beforePaydayPlan.commitments = [
  { id: 'first', label: 'First', date: '2026-01-15', amount: 100, confidence: 'confirmed' },
  { id: 'second', label: 'Second', date: '2026-01-15', amount: 200, confidence: 'confirmed' },
];
const beforeSim = F.simulate(beforePaydayPlan, '2026-01-15',
  { horizonDays: 30, viewDays: 30, weeklyVariable: 0 });
const beforeSeq = F.fundingSequence(beforePaydayPlan, '2026-01-15');
const beforeSchedule = F.planSpendPaydayFunding(beforePaydayPlan, '2026-01-15',
  beforeSim, beforeSeq, F.majorPlans(beforePaydayPlan, '2026-01-15', { weeklyVariable: 0 }));
ok(beforeSchedule.status === 'funding-gap' && beforeSchedule.gap
  && cent(beforeSchedule.gap.required) === 30000
  && cent(beforeSchedule.gap.shortBy) === 30000
  && beforeSchedule.gap.affected.slice().sort().join(',') === 'first,second',
  'all protected costs before the first payday are aggregated into the imminent gap');

const asOf = data.meta.asOf;
const advice = F.recommend(data.plan, asOf, {
  fundingSources: data.plan.funding && data.plan.funding.options,
  debts: data.debts, extraFacilities: data.revolvingExtra, periods,
});
const schedule = advice.planSpendPaydayFunding;
const paydayPlan = fixture(100, 150, false);
paydayPlan.opening.asOf = '2026-01-02';
const currentPayday = F.recommend(paydayPlan, '2026-01-02', {});
ok(cent(currentPayday.planSpendPaydayFunding.paydays[0].contribution)
  === cent(currentPayday.paydayAllocation.futureCosts.find(row => row.id === 'trip').allocated),
  'current-payday serial contribution agrees with the incumbent payday allocation');
const twoCostPaydayPlan = fixture(100, 150, false);
twoCostPaydayPlan.opening.asOf = '2026-01-02';
twoCostPaydayPlan.commitments = [
  { id: 'early', label: 'Early', date: '2026-01-31', amount: 150, confidence: 'confirmed' },
  { id: 'later', label: 'Later', date: '2026-02-10', amount: 150, confidence: 'confirmed' },
];
const twoCostPayday = F.recommend(twoCostPaydayPlan, '2026-01-02', {});
const incumbentNamed = twoCostPayday.paydayAllocation.futureCosts
  .filter(row => Number(row.allocated) > 0)
  .map(row => row.id + ':' + cent(row.allocated)).sort().join(',');
const serialNamed = twoCostPayday.planSpendPaydayFunding.paydays[0].allocations
  .filter(row => Number(row.amount) > 0)
  .map(row => row.id + ':' + cent(row.amount)).sort().join(',');
ok(serialNamed === incumbentNamed,
  'current-payday serial named allocations exactly reuse the incumbent payday authority');
ok(schedule && schedule.status === 'ready', 'explicit no-earmark fixture preserves the incumbent complete schedule');
const horizon = advice.knowledge.days;
const sim = F.simulate(data.plan, asOf, Object.assign({}, advice.simOptions, {
  weeklyVariable: advice.weekly, horizonDays: horizon, viewDays: horizon,
  viewStart: asOf,
}));
const independentPaydays = paydays(data.plan.income.find(row => row.id === 'payroll').anchor,
  asOf, sim.end);
ok(schedule.paydays.length === independentPaydays.length
  && schedule.paydays.every((row, index) => row.payday === independentPaydays[index]),
  'every contribution belongs to an independently dated Seaspan period');
ok(schedule.paydays.every(row => row.payday >= asOf),
  'no contribution predates the Forecast opening');
ok(schedule.openingProtected === null && schedule.projectionOpeningProtected === 0,
  'unknown existing savings stay unknown; projected allocation opens at zero');

const costById = new Map(schedule.costs.map(row => [row.id, row]));
const expectedCosts = advice.fundingSequence.filter(row => row.date && row.date >= asOf
  && row.date <= sim.end && row.flexibility !== 'optional');
ok(expectedCosts.map(row => row.id).sort().join(',')
  === schedule.costs.map(row => row.id).sort().join(','),
  'schedule includes exactly the active dated protected Forecast costs');
const expectedPoint = new Set(expectedCosts.filter(row => row.need != null).map(row => row.id));
const allocated = new Map(schedule.costs.map(row => [row.id, 0]));
const consumed = new Map(schedule.costs.map(row => [row.id, 0]));
const actualEvents = new Map();
for (const event of sim.events) {
  if (!costById.has(event.id) || event.date !== costById.get(event.id).date) continue;
  if (['commitment', 'bill', 'reserve'].includes(event.kind)) {
    actualEvents.set(event.id, (actualEvents.get(event.id) || 0) + 1);
  }
}
let protectedBalance = 0;
let allContributions = 0;
let allConsumed = 0;
let priorClose = cent(F.startingCashAmount(data.plan));
let cumulativePaid = 0;
const capacities = [];
const cumulativeDue = [];
let due = 0;
for (let index = 0; index < schedule.paydays.length; index++) {
  const row = schedule.paydays[index];
  const span = sim.daily.filter(day => day.date >= row.payday && day.date <= row.through);
  const pointPaid = sim.events.filter(event => expectedPoint.has(event.id)
    && event.date >= row.payday && event.date <= row.through
    && ['commitment', 'bill', 'reserve'].includes(event.kind))
    .reduce((sum, event) => sum + cent(-event.amount), 0);
  ok(pointPaid === row.payments.reduce((sum, payment) => sum + cent(payment.amount), 0),
    'period consumption names exactly the incumbent point-payment events');
  const close = cent(span.at(-1).balance);
  const netWithoutPointPayments = close - priorClose + pointPaid;
  const capacity = Math.max(0, index === 0
    ? netWithoutPointPayments + priorClose - cent(sim.buffer) : netWithoutPointPayments);
  capacities.push(capacity);
  ok(cent(row.capacity) === capacity, 'pay-period capacity reconciles to cash walk net of point payments');
  ok(cent(row.contribution) <= capacity, 'contribution stays within its authoritative period capacity');
  ok(near(cent(row.openingProtected), protectedBalance), 'protected carry enters this payday once');
  protectedBalance += cent(row.contribution);
  allContributions += cent(row.contribution);
  ok(near(cent(row.protectedAfterPayday), protectedBalance), 'payday earmark changes protection, not cash');
  let allocatedHere = 0;
  for (const part of row.allocations) {
    ok(costById.has(part.id), 'allocation names a Forecast cost');
    allocated.set(part.id, allocated.get(part.id) + cent(part.amount));
    allocatedHere += cent(part.amount);
  }
  ok(near(allocatedHere, cent(row.contribution)), 'each contributed dollar is named once');
  for (const payment of row.payments) {
    ok(payment.date >= row.payday && payment.date <= row.through,
      'payment is consumed in its actual cash period');
    ok(actualEvents.get(payment.id) === 1, 'actual payment remains one economic cash event');
    ok(near(cent(payment.amount), cent(costById.get(payment.id).baseRequirement)),
      'protected consumption refers to the authoritative cash amount');
    consumed.set(payment.id, consumed.get(payment.id) + cent(payment.protectedConsumed));
    protectedBalance -= cent(payment.protectedConsumed);
    allConsumed += cent(payment.protectedConsumed);
  }
  ok(near(cent(row.protectedAfterPayments), protectedBalance),
    'opening protection plus contribution minus consumption equals closing protection');
  priorClose = close;
  for (const cost of expectedCosts) {
    if (cost.date >= row.payday && cost.date <= row.through) due += cent(cost.bounds.floor);
  }
  cumulativeDue.push(due);
}
ok(near(allContributions - allConsumed, protectedBalance),
  'reserve conservation holds across the full schedule');
for (const cost of schedule.costs) {
  const got = allocated.get(cost.id);
  ok(got <= cent(cost.baseRequirement), 'no cost receives more base funding than required');
  if (cost.projectedFullyFunded) ok(got === cent(cost.baseRequirement),
    'every fully funded cost has all base contributions');
  if (cost.kind === 'payment') {
    ok(actualEvents.get(cost.id) === 1, 'dated point payment appears exactly once in Forecast events');
    ok(consumed.get(cost.id) === cent(cost.baseRequirement),
      'one payment consumes exactly its named protection');
  } else {
    ok(!actualEvents.has(cost.id), 'dated range reserve has no synthetic economic payment');
  }
  ok(cost.contributions.every(part => part.payday <= cost.date),
    'nothing is funded after its authoritative cash date');
}
ok(schedule.costs.filter(cost => cost.id === 'provincials').length === 1
  && schedule.costs.some(cost => cost.id === 'provincials' && cost.date === '2027-02-12'
    && cent(cost.baseRequirement) === 150000)
  && !schedule.unscheduled.some(cost => cost.id === 'provincials'),
  'Provincials joins the schedule once at the approved funding-ready target');
ok(!sim.events.some(event => event.amount === 9500 || /silver/i.test(event.label || '')),
  'silver proceeds are absent from the canonical cash walk');
const roadAhead = F.baselineTrajectory(data.plan, data.debts, asOf, { periods });
ok(roadAhead.status === 'ready'
  && roadAhead.payPeriods.some(row => row.stage2 && row.stage2.result.amount < 0)
  && schedule.status === 'ready',
  'negative standalone Stage 2 periods are not summed into a funding reserve or false gap');

const contributionsOn = new Map();
const consumptionOn = new Map();
for (const row of schedule.paydays) {
  contributionsOn.set(row.payday, (contributionsOn.get(row.payday) || 0) + cent(row.contribution));
  for (const payment of row.payments) consumptionOn.set(payment.date,
    (consumptionOn.get(payment.date) || 0) + cent(payment.protectedConsumed));
}
let held = 0;
for (const day of sim.daily) {
  held += contributionsOn.get(day.date) || 0;
  held -= consumptionOn.get(day.date) || 0;
  ok(held >= 0 && held <= Math.floor((day.balance - sim.buffer) * 100 + 0.000001),
    'daily protected carry stays inside the incumbent cash balance above buffer');
}
ok(held === protectedBalance, 'day-by-day reserve replay reaches the published ending balance');
const simAgain = F.simulate(data.plan, asOf, Object.assign({}, advice.simOptions, {
  weeklyVariable: advice.weekly, horizonDays: horizon, viewDays: horizon, viewStart: asOf,
}));
ok(JSON.stringify(simAgain.daily) === JSON.stringify(sim.daily)
  && JSON.stringify(simAgain.events) === JSON.stringify(sim.events),
  'earmarking does not alter cash balances or add a second economic event');

// Independent feasibility certificate for every positive minimum-now row:
// reduce it by one cent, then give every later period its full capacity.
// Some due-period cumulative demand must still be missed.
for (let i = 0; i < schedule.paydays.length; i++) {
  if (cent(schedule.paydays[i].contribution) === 0) continue;
  let maxPossible = schedule.paydays.slice(0, i)
    .reduce((sum, row) => sum + cent(row.contribution), 0)
    + cent(schedule.paydays[i].contribution) - 1;
  let missed = maxPossible < cumulativeDue[i];
  for (let j = i + 1; j < schedule.paydays.length && !missed; j++) {
    maxPossible += capacities[j];
    if (maxPossible < cumulativeDue[j]) missed = true;
  }
  ok(missed, 'one-cent reduction makes a protected cash date infeasible even with maximum later capacity');
}

// The browser uses the one Forecast publication and does no schedule math.
const src = read('public/plan-spend.js');
ok(/advice\.planSpendPaydayFunding/.test(src) && /Forecast\.recommend\(/.test(src),
  'Plan Spend reprints the Forecast recommendation publication');
ok(!/Forecast\.(simulate|expandEvents|fundingSequence|paydayAllocation)\(/.test(src)
  && !/plan\.commitments/.test(src) && !/\.reduce\(/.test(src)
  && !/\.need\s*[-+*/]/.test(src),
  'page has no second planner, commitment store, or schedule arithmetic');
const appSrc = read('public/app.js');
const grab = re => { const match = re.exec(appSrc); assert.ok(match); return match[0]; };
const helpers = [grab(/^const money = .*$/m), grab(/^const money2 = .*$/m),
  grab(/^const pct = .*$/m), grab(/^const fmtDate = .*$/m),
  grab(/^const fmtDateLong = .*$/m), grab(/^const fmtDateFull = .*$/m)].join('\n');
const context = { Forecast: F, App: { register() {}, boot() {} } };
vm.runInNewContext(helpers + '\n' + src, context);
const page = context.planSpendPageHtml(advice, null);
// The set-aside is a funding projection, so it carries schedule.fundingTrust
// (≈ … estimate, or … calculated), never a bare figure.
const setAsideAmount = '$' + schedule.paydays[0].contribution.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
ok(['estimated', 'calculated'].includes(schedule.fundingTrust)
  && page.lede.includes('Set aside: ' + (schedule.fundingTrust === 'estimated' ? '≈ ' : '') + setAsideAmount
    + (schedule.fundingTrust === 'estimated' ? ' <span class="trust-tag trust-estimated">estimate</span>' : ' <span class="trust-tag">calculated</span>'))
  && page.lede.includes('data-plan-spend-next-payday'),
  'first screen prints the next payday action with its funding trust');
ok(page.lede.includes('Show payday funding plan'), 'following paydays are one disclosure away');
ok(/Projected from the [^<]*2026 opening/.test(page.lede),
  'the payday action exposes its dated Forecast opening');
ok(page.list.includes('data-plan-spend-id="fusion-household"')
  && !page.list.includes('data-plan-spend-id="fusion-household-oct"'),
  'Fusion is one card while instalments remain separate events');
const undatedPlan = fixture(100, 37, false);
delete undatedPlan.commitments[0].date;
const undatedPage = context.planSpendPageHtml(F.recommend(undatedPlan, '2026-01-01', { weeklyVariable: 0 }), null);
ok(/Funding schedule unavailable.*cash date not established/.test(undatedPage.list),
  'undated card fails closed in household language');

if (process.argv.includes('--review')) {
  console.log('Review artifact: legacy no-earmark fixture opening ' + asOf + '; not the active configured household funding plan');
  const reviewRemaining = new Map(schedule.costs.map(cost => [cost.id, cent(cost.baseRequirement)]));
  for (const row of schedule.paydays) {
    for (const allocation of row.allocations) reviewRemaining.set(allocation.id,
      reviewRemaining.get(allocation.id) - cent(allocation.amount));
    console.log(JSON.stringify({
      payday: row.payday, protect: row.contribution, allocations: row.allocations,
      protectedAfterPayday: row.protectedAfterPayday,
      paymentsBeforeNextPayday: row.payments,
      remainingByPlan: schedule.costs.map(cost => ({ id: cost.id,
        label: cost.label, amount: reviewRemaining.get(cost.id) / 100 })),
    }));
  }
  console.log('Earliest funding gap: ' + JSON.stringify(schedule.gap));
}
console.log('Plan Spend payday funding: ' + checks + ' independent checks passed');
