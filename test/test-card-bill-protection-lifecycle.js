'use strict';
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const make = require('./fixtures/pending-card-bill-data');
const LmGroups = require('./lm-groups-fixture.js');
let checks = 0, failures = 0;
function ok(condition, label) {
  checks++; if (!condition) failures++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}`);
}
const cents = amount => Math.round(amount * 100);
function observe(input) {
  const before = JSON.stringify(input);
  const data = Live.fromObservation({ provider: 'lunchmoney', ...input }).data;
  ok(JSON.stringify(input) === before, 'the invented observation remains immutable');
  ok(JSON.stringify(Live.fromObservation({ provider: 'lunchmoney', ...input }).data) === JSON.stringify(data),
    'repeated refresh cannot accumulate purchase or payment movements');
  data.plan = LmGroups.groupPlan(data.plan);
  const packet = data.liveOverlay.currentPeriodActuals = LmGroups.groupPacket(
    { ...data.liveOverlay.currentPeriodActuals, categoryGroupIds: undefined }, data.plan);
  const opts = { debts: data.debts, currentPeriodActuals: packet };
  const simulate = (days, plan = data.plan) => F.simulate(plan, input.asOf, { ...opts,
    weeklyVariable: 0, viewDays: days, horizonDays: days, targetBuffer: 0 });
  return { input, data, packet, opts, simulate };
}
for (const early of [true, 'next-period']) for (const stage of ['pending', 'posted', 'partial', 'full']) {
  const covered = stage === 'partial' ? 20 : stage === 'full' ? 73.21 : 0;
  const r = observe(covered ? make.withBackfill(covered, early) : make(stage, early));
  const sim = r.simulate(5), pending = stage === 'pending';
  const label = stage + '/' + early;
  // Independent cash/debt identities: Bills = 500 - backfill;
  // card = 400 + purchase - backfill; available = 500 - purchase.
  ok(cents(F.postedHouseholdChequingCash(r.data.plan)) === 50000 - cents(covered),
    label + ': observed cash already includes the posted transfer once');
  ok(cents(r.data.debts[0].balance) === (pending ? 40000 : 47321) - cents(covered),
    label + ': observed posted debt already includes purchase and transfer once');
  ok(cents(r.data.debts[0].pending) === (pending ? 7321 : 0),
    label + ': pending exposure follows the actual posting state');
  ok(cents(sim.ending - sim.requiredCashFloor) === 42679,
    label + ': the lifecycle protects exactly one 73.21 expense');
  ok(cents(r.simulate(40).ending - r.simulate(40).requiredCashFloor) === 35358,
    label + ': the next monthly occurrence adds one further expense');
  if (!pending) {
    ok(cents(sim.ending) === 50000 - cents(covered) && cents(sim.totals.reserved) === 0,
      label + ': the future schedule does not replay cash already protected or paid');
    ok(cents(sim.cardPurchaseCoverage.reservedCash) === 7321 - cents(covered),
      label + ': only the actual uncovered purchase remains in coverage');
    ok(cents(sim.cardPurchaseCoverage.purchases[0].covered) === cents(covered),
      label + ': confirmed allocation remains unchanged');
  }
  ok(!(r.data.plan.opening.representedEvents || []).some(row => row.id === 'invented-card-service'),
    label + ': future card purchases never acquire a cash-omit receipt from backfill');
  ok(r.packet.representedActuals.filter(row => row.id === 'invented-card-service').length
      === (pending ? 0 : 1), label + ': only posted purchase evidence supplies an observed actual');
  const advice = F.recommend(r.data.plan, r.input.asOf, r.opts);
  const target = early === true ? advice.defaultView
    : advice.payPeriodViews.find(period => period.start === '2034-10-13');
  ok(target && cents(target.balanceAfterDeductions) === -7321,
    label + ': the owning Budget period keeps one planned deduction');
  const bill = advice.defaultView.bills.find(row => row.id === 'invented-card-service'
    && row.date === r.data.plan.bills[0].firstDue);
  ok(bill && cents(bill.planned) === 7321 && (!pending || bill.status !== 'PAID'),
    label + ': planned amount stays intact and pending never becomes Paid');
  ok(sim.cardPurchaseCoverage.payments.every(payment => payment.satisfiesMinimum === false),
    label + ': a purchase backfill does not settle an issuer minimum');
}
for (const covered of [20, 73.21]) {
  const r = observe(make.withBackfill(covered));
  for (const dateState of ['older', 'missing', 'future']) {
    const plan = JSON.parse(JSON.stringify(r.data.plan));
    plan.startingCash.breakdown.find(row => row.id === 'chequing-a').value = 500;
    if (dateState === 'missing') delete plan.opening.asOf;
    else plan.opening.asOf = F.addDays(r.input.asOf, dateState === 'older' ? -1 : 1);
    const before = JSON.stringify(plan), sim = r.simulate(5, plan);
    ok(cents(sim.totals.reserved) === cents(covered),
      dateState + '/' + covered + ': paid cash is not credited without current opening inclusion');
    ok(cents(sim.ending - sim.requiredCashFloor) === 42679,
      dateState + '/' + covered + ': an unreduced opening still protects the whole expense');
    ok(JSON.stringify(plan) === before, dateState + ': Forecast never rewrites cash evidence');
  }
}
for (const control of ['unconfirmed', 'missing-cash-leg', 'pending-cash-leg', 'duplicate-intent', 'pending-purchase']) {
  const input = make.withBackfill(20);
  if (control === 'unconfirmed') input.data.plan.cardPurchaseCoverage.payments[0].confirmed = false;
  if (control === 'missing-cash-leg') input.payload.transactions = input.payload.transactions.filter(row => row.id !== 81002);
  if (control === 'pending-cash-leg') input.payload.transactions.find(row => row.id === 81002).is_pending = true;
  if (control === 'duplicate-intent') input.data.plan.cardPurchaseCoverage.payments.push({
    ...input.data.plan.cardPurchaseCoverage.payments[0], id: 'invented-second-intent' });
  if (control === 'pending-purchase') {
    input.payload.transactions.find(row => row.id === 81001).is_pending = true;
    input.payload.accounts[3].balance = 380;
  }
  const r = observe(input), sim = r.simulate(5);
  ok(sim.cardPurchaseCoverage.status === 'unavailable', control + ': invalid intent or movement remains unknown');
  ok(!sim.events.some(event => event.cardPurchaseProtection), control + ': unavailable evidence grants no reservation credit');
  if (control === 'pending-purchase') ok(!(r.data.plan.opening.representedEvents || []).some(row =>
    row.id === 'invented-card-service'), 'pending purchase cannot gain a settlement receipt from backfill');
}
console.log(`${checks - failures}/${checks} checks passed.`);
process.exitCode = failures ? 1 : 0;
