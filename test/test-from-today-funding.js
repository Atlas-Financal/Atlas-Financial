'use strict';
// Independent supplied-dollar ledger, exercised through recommend (not a
// second invocation of the allocator as an oracle). All data is synthetic.
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const fixture = require('./fixtures/budget-funding-data');
const AS_OF = '2026-08-20';
function state() {
  const data = fixture();
  data.plan.cardPurchaseCoverage = require('./fixtures/card-coverage-opening')('2026-08-14');
  data.meta.asOf = data.plan.opening.asOf = AS_OF;
  data.plan.opening.priorAsOf = '2026-08-13';
  data.plan.startingCash.breakdown[0].value = 1000;
  data.plan.startingCash.breakdown.push({ id: 'chequing-b', value: 0 });
  data.plan.defaults.targetBuffer = 50;
  data.plan.bills.push({ id: 'still-due', label: 'Still due', frequency: 'once',
    date: '2026-08-25', amount: 150, confidence: 'confirmed' });
  data.plan.obligations.push({ id: 'minimum', label: 'Required card payment',
    debtId: 'travelvisa', effect: 'payment', frequency: 'once', date: '2026-08-25',
    amount: 25, confidence: 'confirmed' });
  data.debts = [{ id: 'travelvisa', structure: 'Revolving', balance: 400,
    pending: 50, rate: 20, limit: 1000 }];
  const packet = { schema: 'atlas-current-period-actuals/v1', observationAsOf: AS_OF,
    coverageStart: '2026-08-14', coverageThrough: AS_OF,
    transactionCoverage: 'complete', pendingCoverage: 'complete', transactions: [
      { id: 'synthetic-groceries', date: '2026-08-19', amount: 50, account: 'travelvisa',
        accountRole: 'revolving-credit', categoryLabel: 'Groceries', displayedPayee: 'Synthetic grocer', pending: true },
      { id: 'synthetic-payroll', date: '2026-08-14', amount: -1000, account: 'chequing-a',
        accountRole: 'household-cash', categoryLabel: 'Income', kindHint: 'income', pending: false },
    ] };
  return { data, packet };
}
const run = (s, opts = {}) => F.recommend(s.data.plan, AS_OF,
  { debts: s.data.debts, currentPeriodActuals: require('./fixtures/card-coverage-opening').packet(s.packet), ...opts });
const current = a => a.payPeriodViews.find(p => p.start === '2026-08-14');
const today = s => current(run(s)).fromTodayFunding;
const s = state(), before = JSON.stringify(s), a = run(s), f = current(a).fromTodayFunding;
assert.equal(f.status, 'ready');
assert.equal(f.currentCash, 1000, 'payroll is already in the observed opening, not another 1000');
assert.equal(f.operatingBills, 200 + 150 + 25);
assert.equal(f.remainingHousehold, 300 - 50, 'pending card purchase fulfills consumption once');
assert.equal(f.requiredOperatingCash, 200 + 150 + 25 + 250 + 50 + 50);
assert.equal(f.availableNow, 1000 - 200 - 150 - 25 - 250 - 50 - 50);
assert.equal(f.contribution, 600 - (1000 - 200 - 150 - 300));
assert.equal(f.cashAfterProposal, 1000 - 250);
assert.equal(f.items[0].cumulativeProposed, 250);
assert.equal(f.items[0].remainingGap, 350);
assert.equal(f.periods[1].contribution, 350);
assert.equal(f.periods[1].items[0].cumulativeProposed, 600);
assert.equal(f.periods[1].items[0].remainingGap, 0);
assert.equal(f.periods[1].protectedAfterPayments, 0, 'payment consumes the earmark, not new cash twice');
assert.equal(f.actualSaved, null);
assert.equal(f.items[0].actualSaved, null);
assert.equal(f.originalPaydayPlan, null);
assert.equal(current(a).plannedCostFunding.contribution, null);
assert.equal(a.payPeriodViews.find(p => p.start === '2026-08-28').plannedCostFunding.contribution, 350,
  'existing future-payday income capacity stays consistent');
assert.deepEqual(run(s), a, 'identical refreshes produce identical publications');
assert.equal(JSON.stringify(s), before, 'no inputs, observations or saved balance written');

// A paid bill is inside the lower cash balance. Settlement releases its hold
// exactly once; the resulting proposal is unchanged, not $200 richer.
const paid = state();
paid.data.plan.startingCash.breakdown[0].value -= 200;
paid.data.plan.opening.representedEvents = [{ id: 'bill', date: '2026-08-14' }];
const paidFunding = today(paid);
assert.equal(paidFunding.operatingBills, 150 + 25);
assert.equal(paidFunding.availableNow, f.availableNow);
assert.equal(paidFunding.contribution, 250);

// Card posting and interest: 450 principal accrues six days before the
// Aug 25 payment and one day after it; the cash payment is still only $25.
const posted = state(); posted.packet.transactions[0].pending = false;
posted.data.debts[0].balance = 450; posted.data.debts[0].pending = 0;
assert.deepEqual(today(posted), f);
for (const input of [s, posted]) {
  const debt = F.projectDebts(input.data.plan, input.data.debts, AS_OF, { debtHorizonDays: 7 });
  const expected = (450 * (1 + .20 / 365) ** 6 - 25) * (1 + .20 / 365);
  assert.ok(Math.abs(debt.byId.travelvisa.balance - expected) < 1e-9);
  assert.equal(debt.byId.travelvisa.paid, 25);
}
const issuer = state();
issuer.packet.transactions.push({ ...issuer.packet.transactions[0], id: 'synthetic-interest',
  amount: 20, categoryLabel: 'Interest charge', displayedPayee: 'INTEREST CHARGE -PURCHASE' });
issuer.data.debts[0].pending = 70;
assert.equal(today(issuer).remainingHousehold, 250, 'issuer interest is debt, not household consumption');
assert.equal(today(issuer).contribution, 250);
const issuerWalk = F.projectDebts(issuer.data.plan, issuer.data.debts, AS_OF, { debtHorizonDays: 1 });
assert.ok(Math.abs(issuerWalk.byId.travelvisa.interest - 470 * .20 / 365) < 1e-9);
issuer.data.debts[0].pending = 50;
assert.equal(today(issuer).contribution, null, 'issuer charges also require complete facility evidence');

// Extra cash already received may back the opening but is never added again
// from an Other Income, refund or internal-transfer observation.
for (const [label, kind] of [['Other Income', 'income'], ['Refund', 'refund'], ['Transfer', 'transfer']]) {
  const extra = state(); extra.data.plan.startingCash.breakdown[0].value += 125;
  extra.packet.transactions.push({ id: 'synthetic-' + kind, date: AS_OF, amount: -125,
    account: 'chequing-a', accountRole: 'household-cash', categoryLabel: label,
    kindHint: kind, pending: false });
  const got = today(extra);
  assert.equal(got.currentCash, 1125);
  assert.equal(got.availableNow, f.availableNow + 125);
  assert.equal(got.contribution, 250);
  assert.equal(got.futureIncomeThisPeriod, 0);
}
const reserves = state();
reserves.data.plan.startingCash.breakdown.push({ id: 'savings', value: 9000 });
reserves.data.plan.startingCash.heldElsewhere = [{ id: 'silver', value: 9000 }];
assert.deepEqual(today(reserves), f, 'shared savings / silver cannot double-count or become spendable');

const arriving = state();
arriving.data.plan.income.push({ id: 'future-confirmed', label: 'Future confirmed receipt',
  frequency: 'once', date: '2026-08-25', amount: 500, confidence: 'confirmed' });
assert.equal(today(arriving).availableNow, f.availableNow, 'future receipts cannot fund today');
assert.equal(today(arriving).futureIncomeThisPeriod, 500);
const onPayday = state();
onPayday.data.plan.opening.asOf = '2026-08-14';
delete onPayday.data.plan.opening.priorAsOf;
onPayday.packet.observationAsOf = onPayday.packet.coverageThrough = '2026-08-14';
onPayday.packet.transactions = [];
onPayday.data.debts[0].pending = 0;
const paydayAdvice = F.recommend(onPayday.data.plan, '2026-08-14', {
  debts: onPayday.data.debts, currentPeriodActuals: onPayday.packet });
const paydayFunding = current(paydayAdvice).fromTodayFunding;
assert.equal(paydayFunding.currentCash, 1000);
assert.equal(paydayFunding.futureIncomeThisPeriod, 0, 'same-day scheduled payroll is not added to observed cash');
assert.equal(paydayFunding.availableNow, 1000 - 200 - 150 - 25 - 300 - 50);
assert.equal(paydayFunding.contribution, 250);

const poor = state(); poor.data.plan.startingCash.breakdown[0].value = 750;
const gap = today(poor);
assert.equal(gap.status, 'funding-gap');
assert.equal(gap.contribution, 750 - 725);
assert.equal(gap.gap.shortBy, 250 - 25);
assert.equal(gap.items[0].remainingGap, 600 - 25);
assert.equal(gap.periods[1].contribution, null);
assert.match(gap.periods[1].reason, /2026-08-20.*225.00.*Named cost/);
const insufficient = state(); insufficient.data.plan.startingCash.breakdown[0].value = 100;
assert.equal(today(insufficient).contribution, 0);
assert.equal(today(insufficient).operatingShortfall, 725 - 100);

// Systems Review #470 P1: no unreceived credit, including the purpose-debt
// path, may turn $25 of current capacity into a $250 instruction. Same-day
// modelled draws are not evidence of receipt either. Later repayment remains
// an outflow; it must not disappear along with the proposed credit.
for (const date of [AS_OF, '2026-08-25']) {
  for (const opts of [
    { plannedFlows: [{ date, amount: 1000, id: 'synthetic-loan', debtId: 'heloc' }] },
    { injections: [{ date, amount: 1000, id: 'synthetic-recovery', debtId: 'heloc' }] },
  ]) {
    const got = current(run(poor, opts)).fromTodayFunding;
    assert.equal(got.status, 'funding-gap');
    assert.equal(got.operatingBills, 375);
    assert.equal(got.requiredOperatingCash, 725);
    assert.equal(got.availableNow, 25);
    assert.equal(got.contribution, 25);
    assert.equal(got.gap.shortBy, 225);
  }
}
const repayment = current(run(poor, { plannedFlows: [
  { date: '2026-08-25', amount: 1000, id: 'synthetic-loan', debtId: 'heloc' },
  { date: '2026-08-26', amount: -25, id: 'synthetic-repayment', debtId: 'heloc' },
] })).fromTodayFunding;
assert.equal(repayment.operatingBills, 400);
assert.equal(repayment.availableNow, 0);
assert.equal(repayment.contribution, 0);

// P1: an independent daily operating ledger disproves the old $250 + $350
// instruction. The named $600 payment leaves $25 on Sep 24, below the $100
// floor ($50 buffer + $50 uncovered purchase). Only $525 of that cost is compatible with all known operations.
// Withholding is intentional: this repair does not invent a new allocation
// priority or alter the established future-payday publication.
const laterBill = state();
laterBill.data.plan.bills.push({ id: 'later-operations', label: 'Later operating bill',
  frequency: 'once', date: '2026-09-20', amount: 600, confidence: 'confirmed' });
function independentCarry(cost) {
  const days = [];
  let cash = 1000;
  for (let day = AS_OF; day <= '2026-09-24'; day = F.addDays(day, 1)) {
    if (day === AS_OF) cash -= 200;
    if (day === '2026-08-25') cash -= 150 + 25;
    if (day === '2026-08-28' || day === '2026-09-11') cash += 1000 - 200;
    if (day === '2026-08-28') cash -= 150;
    if (day === '2026-09-10') cash -= cost;
    if (day === '2026-09-20') cash -= 600;
    const start = day < '2026-08-28' ? AS_OF : day < '2026-09-11' ? '2026-08-28' : '2026-09-11';
    const count = day < '2026-08-28' ? 8 : 14;
    const householdCents = day < '2026-08-28' ? 25000 : 30000;
    const index = Math.round((Date.parse(day) - Date.parse(start)) / 86400000);
    cash -= (Math.floor(householdCents * (index + 1) / count) - Math.floor(householdCents * index / count)) / 100;
    cash = Math.round(cash * 100) / 100;
    days.push({ day, cash });
  }
  return days;
}
const unsafeCarry = independentCarry(600);
for (const [date, dollars] of [['2026-08-27', 375], ['2026-09-10', 125], ['2026-09-24', 25]]) {
  assert.equal(unsafeCarry.find(d => d.day === date).cash, dollars);
}
assert.equal(Math.min(...independentCarry(525).map(d => d.cash)), 100);
const blockedCarry = today(laterBill);
assert.equal(blockedCarry.status, 'unavailable');
assert.equal(blockedCarry.contribution, null);
assert.equal(blockedCarry.items[0].cumulativeProposed, null);
assert.equal(blockedCarry.items[0].projectedFullyFunded, undefined);
assert.equal(blockedCarry.periods.length, 0, 'no earlier unsafe proposals survive the operating barrier');
assert.match(blockedCarry.reason, /operating.*2026-09-24.*75.00.*100.00/i);
const boundary = structuredClone(laterBill);
boundary.data.plan.bills.at(-1).amount = 525;
assert.equal(today(boundary).status, 'ready', 'exactly meeting the floor must remain available');
assert.equal(today(boundary).periods[1].items[0].remainingGap, 0);
const earlyGapWithLaterBreach = structuredClone(laterBill);
earlyGapWithLaterBreach.data.plan.startingCash.breakdown[0].value = 750;
earlyGapWithLaterBreach.data.plan.bills.at(-1).amount = 1000;
assert.equal(today(earlyGapWithLaterBreach).contribution, null,
  'a first protected-cost gap must not hide a known later operating barrier to today\'s $25');

const overdue = state(); overdue.data.plan.commitments[0].date = '2026-08-19';
assert.match(today(overdue).reason, /overdue/);
assert.equal(today(overdue).items[0].date, '2026-08-19');
assert.equal(today(overdue).contribution, null);
const undated = state(); undated.data.plan.commitments.push({ id: 'unknown-date', label: 'Undated cost',
  amount: 100, confidence: 'estimated' });
assert.equal(today(undated).unscheduled.find(r => r.id === 'unknown-date').contribution, null);
assert.equal(today(undated).unscheduled.find(r => r.id === 'unknown-date').date, null);
assert.equal(today(undated).status, 'unavailable');
assert.equal(today(undated).trust, 'unavailable');
assert.equal(today(undated).contribution, null);
assert.equal(today(undated).unscheduled.find(r => r.id === 'unknown-date').cost, 100);
const beforePayday = state(); beforePayday.data.plan.commitments[0].date = '2026-08-26';
const near = today(beforePayday);
assert.equal(near.contribution, 275, 'near deadline cannot wait for the next payroll');
assert.equal(near.gap.shortBy, 600 - 275);

for (const [name, change] of [
  ['missing actuals', x => { x.packet = null; }],
  ['incomplete coverage', x => { x.packet.transactionCoverage = 'truncated'; }],
  ['unknown pending', x => { x.packet.pendingCoverage = 'unknown'; }],
  ['stale observation', x => { x.packet.observationAsOf = '2026-08-19'; }],
  ['stale cash', x => { x.data.plan.opening.asOf = '2026-08-19'; }],
  ['null cash', x => { x.data.plan.startingCash.breakdown[0].value = null; }],
  ['missing cash', x => { x.data.plan.startingCash.breakdown = []; }],
  ['missing Bills account', x => { x.data.plan.startingCash.breakdown.shift(); }],
  ['missing Weekly account', x => { x.data.plan.startingCash.breakdown.pop(); }],
  ['unknown cash trust', x => { x.data.plan.startingCash.breakdown[1].confidence = 'unknown'; }],
  ['conflicting cash trust', x => { x.data.plan.startingCash.breakdown[1].status = 'CONFLICT'; }],
  ['duplicate cash', x => { x.data.plan.startingCash.breakdown.push({ ...x.data.plan.startingCash.breakdown[0] }); }],
  ['unsupported pending card', x => { x.data.debts[0].pending = 49; }],
  ['duplicate pending observation', x => { x.packet.transactions.push({ ...x.packet.transactions[0] }); }],
  ['missing transaction amount', x => { x.packet.transactions[0].amount = null; }],
  ['duplicate posted identity', x => { x.packet.transactions.push({ ...x.packet.transactions[1] }); }],
  ['unknown cost', x => { x.data.plan.commitments[0].amount = null; }],
]) {
  const input = state(); change(input);
  const got = today(input);
  assert.equal(got.status, 'unavailable', name);
  assert.equal(got.contribution, null, name);
}
const withheld = current(F.recommend(s.data.plan, AS_OF, { debts: s.data.debts,
  currentPeriodActuals: s.packet, operatingPlan: 'unavailable' })).fromTodayFunding;
assert.equal(withheld.contribution, null, 'stale operating plan cannot publish a current proposal');
const estimatedCash = state(); estimatedCash.data.plan.startingCash.breakdown[0].confidence = 'estimated';
assert.equal(today(estimatedCash).trust, 'estimated');
// A live packet must back BOTH canonical stocks, independently of opening
// and transaction dates. Partial, duplicate, stale or mismatched evidence
// cannot inherit the retained canonical balance on a same-date refresh.
const observed = { complete: true, asOf: AS_OF, accounts: [
  { id: 'chequing-a', value: 1000, evidenceDate: AS_OF },
  { id: 'chequing-b', value: 0, evidenceDate: AS_OF },
] };
assert.equal(current(run(s, { operatingPlan: 'live', observedCash: observed })).fromTodayFunding.contribution, 250);
const estimatedObservation = structuredClone(observed);
estimatedObservation.accounts[1].confidence = 'estimated';
assert.equal(current(run(s, { operatingPlan: 'live', observedCash: estimatedObservation })).fromTodayFunding.trust, 'estimated');
for (const change of [
  x => { x.complete = false; },
  x => { x.accounts.shift(); },
  x => { x.accounts.pop(); },
  x => { x.accounts.push({ ...x.accounts[1] }); },
  x => { x.accounts[1].evidenceDate = '2026-08-19'; },
  x => { x.accounts[1].value = 10; },
  x => { x.accounts[1].unknown = true; },
]) {
  const packet = structuredClone(observed); change(packet);
  assert.equal(current(run(s, { operatingPlan: 'live', observedCash: packet })).fromTodayFunding.contribution, null);
}
assert.equal(current(run(s, { operatingPlan: 'live' })).fromTodayFunding.contribution, null);

// Supported rolling-year horizon uses only already-authorized payroll rules.
const year = state(); year.data.plan.payrollPlanningAssumptions = {
  salaryRaiseFactor: 1.04, bonusRate: 0, authorizedThroughYear: 2027 };
const yearFunding = today(year);
assert.ok(yearFunding.through >= '2027-08-01');
assert.ok(yearFunding.through <= '2027-08-20');
assert.equal(yearFunding.trust, 'estimated');
assert.equal(yearFunding.periods.length, 26);
console.log('PASS from-today funding: independent current-cash ledger, settlement, gaps, evidence, horizon and no mutation');
