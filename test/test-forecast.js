'use strict';
// Tests for the forecast engine, run against BOTH a hand-computed fixture and
// the real data.json plan block. `node test/test-forecast.js`
const F = require('../public/forecast.js');
const data = require('../data.json');
const {
  burrardDue, currentRegimeReservedDaily, cardPaidReservedTotal, cardPaidReservedOnDate,
  openingFloor, gapAtBuffer, cashOnDate, streamTotal, representedEventKeys,
} = require('./test-helpers');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

console.log('=== date arithmetic ===');
ok(F.addDays('2026-08-09', 90) === '2026-11-07', 'asOf + 90 days = 7 Nov', F.addDays('2026-08-09', 90));
ok(F.addDays('2026-08-31', 1) === '2026-09-01', 'month rollover');
ok(F.diffDays('2026-08-09', '2026-11-07') === 90, 'diffDays');
ok(F.HOUSEHOLD_TIMEZONE === 'America/Vancouver', 'one IANA household timezone');
ok(F.financialDate('2026-08-18') === '2026-08-18',
  'a calendar date is not reinterpreted as UTC midnight');
// Independent of Forecast.financialDate: August 2026 is PDT (UTC-7).
// DST in 2026 runs 8 March–1 November. 01:06:40.929Z − 7h = 18:06 PDT.
const LIVE_INSTANT = '2026-08-19T01:06:40.929Z';
const independentPdt = new Date(Date.parse(LIVE_INSTANT) - 7 * 3600 * 1000)
  .toISOString().slice(0, 10);
ok(independentPdt === '2026-08-18',
  'independent PDT offset of the live preflight instant is 2026-08-18');
ok(F.financialDate(LIVE_INSTANT) === independentPdt,
  'financialDate agrees with the independent PDT offset');
const NEXT_INSTANT = '2026-08-19T07:06:40.929Z';
const independentNext = new Date(Date.parse(NEXT_INSTANT) - 7 * 3600 * 1000)
  .toISOString().slice(0, 10);
ok(independentNext === '2026-08-19',
  'independent PDT offset of 07:06Z is still 2026-08-19');
ok(F.financialDate(NEXT_INSTANT) === independentNext,
  'an instant that is already 19 August in Vancouver stays 19 August');
// January 2026 is PST (UTC-8). Same clock time is the previous evening.
const WINTER_INSTANT = '2026-01-19T01:06:40.929Z';
const independentPst = new Date(Date.parse(WINTER_INSTANT) - 8 * 3600 * 1000)
  .toISOString().slice(0, 10);
ok(independentPst === '2026-01-18',
  'independent PST offset of the winter instant is 2026-01-18');
ok(F.financialDate(WINTER_INSTANT) === independentPst,
  'IANA zone follows Pacific daylight-saving, not a fixed UTC-7 offset');
ok(F.financialDate('not-a-date') === null, 'unparseable instants fail closed');

console.log('\n=== recurrence expansion ===');
const win = { start: '2026-08-09', end: '2026-11-07' };
const biweekly = F.occurrences({ frequency: 'biweekly', anchor: '2026-08-14' }, win.start, win.end);
ok(biweekly.length === 7, '7 bi-weekly paydays in the window', biweekly.join(', '));
ok(biweekly[0] === '2026-08-14' && biweekly[6] === '2026-11-06', 'first 14 Aug, last 6 Nov');

const monthEnd = F.occurrences({ frequency: 'monthly', day: 31 }, win.start, win.end);
ok(monthEnd.join(',') === '2026-08-31,2026-09-30,2026-10-31', 'day-31 clamps to 30 Sep', monthEnd.join(','));

const firstDue = F.occurrences({ frequency: 'monthly', day: 7, firstDue: '2026-09-07' }, win.start, win.end);
ok(firstDue.join(',') === '2026-09-07,2026-10-07,2026-11-07', 'firstDue skips the paid August 7th', firstDue.join(','));

const longHorizon = F.occurrences({ frequency: 'monthly', day: 15 }, '2026-08-09', '2027-05-01');
ok(longHorizon.includes('2027-01-15') && longHorizon.includes('2027-04-15'),
  'monthly expansion covers an ICS-length horizon, not a fixed 5 months',
  longHorizon.filter(d => d.startsWith('2027')).join(', '));
ok(longHorizon.every(d => d <= '2027-05-01'), 'and stops at the requested end');

const anchorBefore = F.occurrences({ frequency: 'biweekly', anchor: '2026-08-14' }, '2026-08-20', '2026-09-30');
ok(anchorBefore.join(',') === '2026-08-28,2026-09-11,2026-09-25', 'anchor before window start still expands', anchorBefore.join(','));

console.log('\n=== hand-computed fixture ===');
// One income of 1000 on day 3, one bill of 400 on day 5, starting 500,
// weekly variable 70 (=10/day), 14-day window.
const fixture = {
  windowDays: 14,
  defaults: { targetBuffer: 0 },
  startingCash: { amount: 500 },
  income: [{ id: 'p', label: 'Pay', frequency: 'once', date: '2026-01-04', amount: 1000, confidence: 'confirmed' }],
  obligations: [{ id: 'b', label: 'Bill', frequency: 'once', date: '2026-01-06', amount: 400, confidence: 'confirmed' }],
  commitments: [],
};
const sim = F.simulate(fixture, '2026-01-01', { weeklyVariable: 70, targetBuffer: 0 });
// Day-by-day: 500 −10×3 = 470 on Jan 3; Jan 4: +1000 −10 → 1460; Jan 6: −400 −10.
ok(near(sim.daily[2].balance, 470), 'balance before income', sim.daily[2].balance.toFixed(2));
ok(near(sim.daily[3].balance, 1460), 'income lands day 4', sim.daily[3].balance.toFixed(2));
ok(near(sim.ending, 500 + 1000 - 400 - 140), 'ending = start + in − out − variable', sim.ending.toFixed(2));
ok(near(sim.min.balance, 470) && sim.min.date === '2026-01-03', 'min is the eve of payday', `${sim.min.balance.toFixed(2)} on ${sim.min.date}`);
ok(sim.weeks.length === 2 && near(sim.weeks[0].opening, 500) && near(sim.weeks[1].opening, sim.weeks[0].closing), 'weeks chain opening=prior closing');
ok(near(sim.totals.confirmedIncome, 1000) && near(sim.totals.obligations, 400) && near(sim.totals.variable, 140), 'totals');

// Intra-day dip: a payment on payday morning cannot hide below the daily close.
const fixture2 = Object.assign({}, fixture, {
  obligations: [{ id: 'b', label: 'Bill', frequency: 'once', date: '2026-01-04', amount: 400, confidence: 'confirmed' }],
});
const sim2 = F.simulate(fixture2, '2026-01-01', { weeklyVariable: 0, targetBuffer: 0 });
ok(near(sim2.daily[3].balance, 1100), 'same-day: income first, then the bill', sim2.daily[3].balance.toFixed(2));

console.log('\n=== the week-by-week track ===');
// Fixture: buffer 100. After week 1 (ends Jan 7) the future holds the Jan 6
// bill of 400 with only variable outflow (10/day) around it. The worst future
// dip from week 1's closing is −400 − 7×10 = −470 by Jan 13... computed by
// hand: cum from Jan 8..14 = −10×7 = −70; no bill remains (Jan 6 is inside
// week 1), so required closing of week 1 = 100 + 70 = 170.
const simReq = F.simulate(fixture, '2026-01-01', { weeklyVariable: 70, targetBuffer: 100 });
ok(near(simReq.weeks[0].requiredClosing, 170), 'week 1 must close ≥ buffer + future net outflow', simReq.weeks[0].requiredClosing.toFixed(2));
ok(near(simReq.weeks[1].requiredClosing, 100), 'final week track equals the buffer', simReq.weeks[1].requiredClosing.toFixed(2));

console.log('\n=== recommender ===');
const recHorizon = F.knowledgeHorizon(fixture, '2026-01-01', {});
const rec = F.recommendWeekly(fixture, '2026-01-01', { targetBuffer: 100 });
// Day 3: 500 − 3W/7 ≥ 100 → W ≤ 933. After pay and the bill, the last
// knowledge-horizon day binds: 1100 − (W/7)×days ≥ 100 → W ≤ 1000 × 7 / days.
const wantRec = Math.floor(((500 + 1000 - 400 - 100) * 7 / recHorizon.days) / 5) * 5;
ok(rec === wantRec, 'solves the binding constraint to the nearest $5', String(rec));
const simRec = F.simulate(fixture, '2026-01-01', {
  weeklyVariable: rec, targetBuffer: 100, horizonDays: recHorizon.days,
});
ok(simRec.min.balance >= 100, 'recommended budget respects the buffer', simRec.min.balance.toFixed(2));
const simOver = F.simulate(fixture, '2026-01-01', {
  weeklyVariable: rec + 10, targetBuffer: 100, horizonDays: recHorizon.days,
});
ok(simOver.min.balance < 100, 'and $10 more breaches it', simOver.min.balance.toFixed(2));

console.log('\n=== the real plan block ===');
const plan = data.plan;
const asOf = data.meta.asOf;
const windowEnd = F.addDays(asOf, plan.windowDays - 1);
const payroll = plan.income.find(s => s.id === 'payroll');
const childBenefit = plan.income.find(s => s.id === 'childBenefit');
const amanda15 = plan.income.find(s => s.id === 'amandaSalary15');
const amandaEom = plan.income.find(s => s.id === 'amandaSalaryMonthEnd');
ok(payroll === plan.income[0], 'payroll is plan.income[0], the EMP-004 routing target');
ok(payroll.confidence === 'estimated',
  'tagged estimated — observed average, not a repeating exact cheque', payroll.confidence);
ok(amanda15 && amandaEom && amanda15.confidence === 'confirmed' && amandaEom.confidence === 'confirmed',
  'Amanda Tennis BC salary streams are confirmed');
ok(!plan.income.some(s => s.id === 'amandaTransfer'),
  'retired amandaTransfer stream is gone');
const expected = F.simulate(plan, asOf, {
  scenario: 'expected', weeklyVariable: 0, targetBuffer: plan.defaults.targetBuffer,
});

// Confirmed income: child benefit plus owner-confirmed Amanda Tennis BC salary.
// Payroll is the expected-regime average, not a confirmed repeating cheque.
const paydays = F.occurrences(payroll, asOf, windowEnd);
ok(paydays.length >= 6 && paydays.every(d => d >= asOf),
  'the 91-day window contains the remaining payroll dates on or after as-of',
  paydays.join(', '));
const wantConfirmed = streamTotal([childBenefit, amanda15, amandaEom], asOf, windowEnd, F.occurrences);
ok(near(expected.totals.confirmedIncome, wantConfirmed), '90-day confirmed income is child benefit plus Amanda salary',
  expected.totals.confirmedIncome.toFixed(2));
const wantEstimated = paydays.length * payroll.amount;
ok(near(expected.totals.estimatedIncome, wantEstimated, 0.05),
  '90-day estimated income is payroll only — Amanda salary is confirmed, not an estimated transfer',
  expected.totals.estimatedIncome.toFixed(2));
const represented = representedEventKeys(plan);
const wantObl = streamTotal(plan.obligations, asOf, windowEnd, F.occurrences, {
  onceOutflowsBind: true, plan, omitRepresented: true,
});
const heloc = plan.obligations.find(o => o.id === 'heloc');
const wantHelocCash = (F.capitalisingCashMinimumOccurrences(heloc, asOf, windowEnd) || [])
  .filter(occ => occ && !represented.has('heloc@' + occ.date))
  .reduce((s, occ) => s + Number(occ.amount || 0), 0);
ok(near(expected.totals.obligations, wantObl + wantHelocCash), '90-day cash obligations include HELOC cash minimum',
  expected.totals.obligations.toFixed(2));
const wantNoncash = F.occurrences(heloc, asOf, windowEnd).length * heloc.amount;
ok(near(expected.totals.noncash, wantNoncash), 'HELOC interest is tracked but not deducted',
  expected.totals.noncash.toFixed(2));
{
  // Capitalise still does not move cash. The encoded cashPayment does.
  const withHeloc = expected.ending;
  const noCashMin = JSON.parse(JSON.stringify(plan));
  const h = noCashMin.obligations.find(o => o.id === 'heloc');
  h.cashPayment = 0;
  const withoutCash = F.simulate(noCashMin, asOf, { scenario: 'expected', weeklyVariable: 0, targetBuffer: plan.defaults.targetBuffer }).ending;
  ok(near(withoutCash - withHeloc, wantHelocCash),
    'HELOC cashPayment is deducted once; capitalise is not a second chequing hit',
    `${withoutCash.toFixed(2)} − ${withHeloc.toFixed(2)} vs ${wantHelocCash.toFixed(2)}`);
}
// streamTotal independently nets a utility-account credit from the firstDue
// occurrence (not household income). Later months stay at the declared amount.
const wantBills = streamTotal(plan.bills, asOf, windowEnd, F.occurrences, {
  plan, onceOutflowsBind: true, omitRepresented: true,
});
ok(near(expected.totals.bills, wantBills), '90-day named bills net utility-account credit once', expected.totals.bills.toFixed(2));
const fortisDates = expected.events.filter(e => e.id === 'fortis').map(e => e.date).join(',');
ok(fortisDates === '2026-09-03,2026-11-03', 'Fortis preserves September and the incumbent future schedule while the confirmed October no-pay bill emits no cash', fortisDates);
const wantCommit = (plan.commitments || [])
  .filter(c => c.date >= asOf && c.date <= windowEnd
    && !(typeof c.settledOn === 'string'
      && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(c.settledOn)
      && c.settledOn <= asOf))
  .reduce((s, c) => s + c.amount, 0);
ok(near(expected.totals.commitments, wantCommit), '90-day commitments', expected.totals.commitments.toFixed(2));
ok(expected.weeks.length === 13, '13 weeks');
const reservedOverWindow = currentRegimeReservedDaily(plan) * expected.daily.length
  + cardPaidReservedTotal(plan, asOf, windowEnd, F.occurrences);
ok(near(expected.ending,
  F.startingCashAmount(plan) + expected.totals.income - expected.totals.obligations
  - expected.totals.bills - expected.totals.commitments - reservedOverWindow),
  'ledger identity holds', expected.ending.toFixed(2));
ok(near(expected.totals.reserved, reservedOverWindow) && near(expected.totals.variable, 0),
  'current-regime reserved is the reserved total, not the weekly-cap variable column',
  expected.totals.reserved.toFixed(2));

// The Burrard pair is atomic: same day, same amount, all or nothing. If a
// future edit splits them across the payday the gap would vanish on paper.
{
  const grp = plan.commitments.filter(c => c.group === 'burrard');
  ok(grp.length === 2 && grp[0].date === grp[1].date, 'both Burrard registrations fall on one date', grp.map(c => c.date).join(','));
  ok((plan.groups || []).some(g => g.id === 'burrard' && g.atomic), 'and the pair is flagged atomic');
  const due = grp.reduce((s, c) => s + c.amount, 0);
  ok(near(due, burrardDue(plan)), 'the atomic pair totals the Burrard due on that day', due.toFixed(2));
  const funding = F.resolveFundingSources(plan.funding.options, data.revolvingExtra, plan, data.debts);
  const can = funding.filter(o => !o.unusable && o.available >= due).map(o => o.id).sort();
  ok(can.length >= 1, 'at least one usable source can cover the Burrard due', can.join(',') || 'none');
  ok(funding.filter(o => o.unusable).every(o => o.unusable === true),
    'cards and overdraft remain marked unusable even when their room changed');
}

// Starting cash is household chequing only — designated savings stays on
// the breakdown as reserve evidence and is not ordinary spendable opening.
const chequingSum = plan.startingCash.breakdown
  .filter(b => b && (b.id === 'chequing-a' || b.id === 'chequing-b'))
  .reduce((s, b) => s + b.value, 0);
const breakdownSum = plan.startingCash.breakdown.reduce((s, b) => s + b.value, 0);
const savingsRow = plan.startingCash.breakdown.find(b => b && b.id === 'savings');
ok(near(F.startingCashAmount(plan), chequingSum),
  'forecast opening cash is the independently summed household chequing accounts',
  F.startingCashAmount(plan).toFixed(2));
ok(savingsRow && !near(breakdownSum, chequingSum),
  'designated savings remains on the breakdown and is not in the spendable opening');
const openingNet = expected.events
  .filter(e => e.date <= asOf && e.kind !== 'noncash' && e.jointCash !== false)
  .reduce((s, e) => s + e.amount, 0);
ok(near(expected.daily[0].balance,
  chequingSum + openingNet - currentRegimeReservedDaily(plan)
    - cardPaidReservedOnDate(plan, asOf, F.occurrences)),
  'day-0 close is opening cash plus joint-cash events that bind at this opening, minus reserved current-regime cash that day',
  expected.daily[0].balance.toFixed(2));
ok(plan.income.filter(s => /tennis bc/i.test(s.label)).map(s => s.id).sort().join(',')
    === 'amandaSalary15,amandaSalaryMonthEnd',
  'owner-confirmed Tennis BC salary nets are household income');
ok(!plan.income.some(s => /coach/i.test(s.label + (s.id || ''))),
  'coaching/business receipts are not counted as household income');

// Scenario ordering: conservative ≤ expected ≤ optimistic on every day.
const cons = F.simulate(plan, asOf, { scenario: 'conservative', weeklyVariable: 0 });
const opti = F.simulate(plan, asOf, { scenario: 'optimistic', weeklyVariable: 0 });
ok(cons.daily.every((d, i) => d.balance <= expected.daily[i].balance + 1e-9), 'conservative never exceeds expected');
ok(expected.daily.every((d, i) => d.balance <= opti.daily[i].balance + 1e-9), 'expected never exceeds optimistic');

// Warriors is an exact $895 point, settled 2026-09-21. This dated opening
// is before that date, so the cash walk still reserves it once.
const warriors = plan.commitments.find(c => c.id === 'warriors');
ok(warriors && warriors.date === '2026-09-23' && near(warriors.amount, 895)
  && warriors.amountMin == null && warriors.settledOn === '2026-09-21',
  'Warriors is owner Logan U13 due 23 Sep at an exact $895, settled 21 Sep');
const noWarriors = F.simulate(plan, asOf, { scenario: 'expected', weeklyVariable: 0, disabled: ['warriors'] });
ok(near(noWarriors.ending - expected.ending, 895),
  'on the 19 Aug opening, disabling unsettled-relative Warriors removes exactly one $895 cash event',
  (noWarriors.ending - expected.ending).toFixed(2));
const afterSettlement = F.simulate(plan, '2026-09-23', { scenario: 'expected', weeklyVariable: 0 });
const afterSettlementOff = F.simulate(plan, '2026-09-23', {
  scenario: 'expected', weeklyVariable: 0, disabled: ['warriors'],
});
ok(near(afterSettlement.ending, afterSettlementOff.ending),
  'on/after settledOn, Warriors is not a second cash reservation');

// Extra debt payments reduce ending cash by the months applied.
const extra = F.simulate(plan, asOf, { scenario: 'expected', weeklyVariable: 0, extraDebtMonthly: 200 });
const extraDates = F.occurrences({ frequency: 'monthly', day: 15 }, asOf, windowEnd);
ok(near(expected.ending - extra.ending, 200 * extraDates.length),
  `extra $200/month × ${extraDates.length} mid-month dates`,
  (expected.ending - extra.ending).toFixed(2));

// The week-by-week track on the real plan: verify the backward pass against a
// brute recomputation from the daily balances.
{
  const s = F.simulate(plan, asOf, { scenario: 'expected', weeklyVariable: 1000, targetBuffer: 500 });
  // Assert the GENERATED collection, then derive the loop from it. Counting
  // iterations of a loop bounded by a literal proves only that the literal was
  // reached — `checked === 12` after `for (i = 0; i < 12; i++)` cannot be false,
  // which is precisely the shape this guard was added to stamp out. Written
  // that way first time round, in the commit whose purpose was to remove it.
  //
  // The distinction that matters: 12 is not an independent fact, it is
  // weeks.length − 1. A window that produced 12 weeks instead of 13 would still
  // compare 12 indexed entries and still report success, while only 11 of them
  // were interior.
  ok(s.weeks.length === 13, 'the window generates 13 weeks', `${s.weeks.length} weeks`);
  const interior = s.weeks.length - 1;
  let allMatch = true, checked = 0;
  for (let i = 0; i < interior; i++) {
    checked++;
    const next = (i + 1) * 7;
    let cum = 0, minCum = Infinity;
    for (let j = next; j < s.daily.length; j++) {
      cum += s.daily[j].balance - s.daily[j - 1].balance;
      if (cum < minCum) minCum = cum;
    }
    const brute = 500 - Math.min(0, minCum);
    if (!near(s.weeks[i].requiredClosing, brute)) {
      ok(false, `track matches brute force at week ${i + 1}`, `${s.weeks[i].requiredClosing} vs ${brute}`);
      allMatch = false;
      break;
    }
  }
  if (allMatch) {
    ok(checked === interior && interior === 12,
      `track matches brute force for all ${interior} interior weeks`,
      `${checked} of ${s.weeks.length - 1} interior weeks compared`);
  }
}

// Recommender. When zero variable spend still sits below the buffer, the
// honest answer is $0 rather than a plausible-looking number.
const buffer = plan.defaults.targetBuffer;
const w = F.recommendWeekly(plan, asOf, { scenario: 'expected', targetBuffer: buffer });
const zeroSim = F.simulate(plan, asOf, { scenario: 'expected', weeklyVariable: 0, targetBuffer: buffer });
const floor = openingFloor(plan, asOf);
ok(zeroSim.min.balance < buffer ? w === 0 : w > 0,
  'returns $0 when even zero spending breaches the buffer; otherwise a real cap',
  `$${w}/week, floor ${zeroSim.min.balance.toFixed(2)}`);
ok(typeof zeroSim.min.balance === 'number' && zeroSim.min.date >= asOf,
  'the zero-spend floor is a dated balance on or after as-of',
  `${zeroSim.min.balance.toFixed(2)} on ${zeroSim.min.date}`);
// Once past the opening squeeze the window is comfortable: from the first
// payday onward a real budget exists.
const later = F.simulate(plan, addDaysISO(asOf, 7), Object.assign({}, { scenario: 'expected', weeklyVariable: 0, targetBuffer: 500 }));
ok(later.ending > 0, 'the window is not structurally short — it is a timing squeeze', later.ending.toFixed(2));
function addDaysISO(iso, n) { return F.addDays(iso, n); }

/* ==================================================================
   OPENING-GAP RECOVERY — the regression that matters

   The shipped page answered "$1,650/week once the gap is covered". It got
   there by re-slicing the plan to start on the first payday, seeding it with
   that payday's own END-OF-DAY balance, and then simulating from that same
   date — so the payroll, the mortgage, Shaw and Fit4Less were all applied a
   second time. The first payday's net was counted twice. At the stale
   $4,468.69 payroll that net was +$2,778.75; at the current $4,264 net it is
   +$2,574.06. The shipped page's $1,650/week answer was the double-count at
   the old payroll. The same method now yields $1,525.

   These checks fail against that implementation.
   ================================================================== */
console.log('\n=== opening-gap recovery ===');

const RECOPTS = { scenario: 'expected', incomeOverrides: {}, disabled: [],
  extraDebtMonthly: 0, targetBuffer: 500 };
const gapRec = F.recommend(plan, asOf, RECOPTS);

ok(floor < buffer ? gapRec.mode === 'openingGap' : gapRec.mode !== 'openingGap',
  'a floor below the buffer is an opening-gap; otherwise it is not',
  `${gapRec.mode}, floor ${floor.toFixed(2)} vs buffer ${buffer}`);
if (gapRec.mode === 'openingGap') {
  ok(near(gapRec.gap.amount, gapAtBuffer(plan, 500)), 'the gap is the buffer less the opening floor', gapRec.gap.amount.toFixed(2));
  ok(gapRec.gap.date >= asOf, 'and it has to be covered on or after as-of', gapRec.gap.date);
  ok(!!gapRec.effectiveFrom, 'spending resumes after the gap is covered', gapRec.effectiveFrom);
} else {
  ok(!gapRec.gap, 'this opening has no opening-gap to fund');
}

const zeroForGap = F.simulate(plan, asOf, Object.assign({}, RECOPTS, { weeklyVariable: 0 }));
const payday = zeroForGap.events.find(e => e.kind === 'income' && e.amount >= 1000);

if (gapRec.mode === 'openingGap') {
// --- 1. the first payday is counted exactly once -------------------------
// The old code's answer. Recomputed here rather than hardcoded, so this stays
// a statement about double counting and not about one stale number.
const oldSliced = JSON.parse(JSON.stringify(plan));
oldSliced.startingCash = {
  amount: zeroForGap.daily.find(p => p.date === payday.date).balance + gapRec.gap.amount,
};
oldSliced.windowDays = F.diffDays(payday.date, zeroForGap.end) + 1;
const oldAnswer = F.recommendWeekly(oldSliced, payday.date, RECOPTS);
ok(gapRec.weekly < oldAnswer, 'the old re-slicing method still overstates the cap',
  `$${gapRec.weekly} vs old $${oldAnswer}`);

// The size of the error is the payday it counted twice — summed from Plan
// rows on that date, not from simulate's own event list.
const paydayNet = zeroForGap.events.filter(e => e.date === payday.date && e.kind !== 'noncash')
  .reduce((s, e) => s + e.amount, 0);
const wantPaydayNet = cashOnDate(plan, payday.date, F.occurrences, 'expected');
ok(near(paydayNet, wantPaydayNet), 'the duplicated day equals Plan cash on that date', paydayNet.toFixed(2));

// --- 2. no event appears twice -------------------------------------------
// Every event in the recovery simulation must be unique on (id, date). The old
// method could not satisfy this: it replayed a whole day of them.
const seen = new Map();
let dupes = 0;
for (const e of gapRec.sim.events) {
  const key = e.id + '@' + e.date;
  seen.set(key, (seen.get(key) || 0) + 1);
}
for (const [key, n] of seen) if (n > 1) { dupes++; console.log(`        duplicate: ${key} ×${n}`); }
ok(dupes === 0, 'every event occurs exactly once in the recovery ledger', `${seen.size} unique events`);

const paydaysInRecovery = gapRec.sim.events.filter(e => e.id === 'payroll').length;
const paydaysExpected = F.occurrences(plan.income.find(s => s.id === 'payroll'), asOf, gapRec.sim.end).length;
ok(paydaysInRecovery === paydaysExpected,
  'the payroll appears once per scheduled payday, no more', `${paydaysInRecovery} of ${paydaysExpected}`);

// --- 3. funding the gap creates no phantom income ------------------------
// The injection is exactly the gap and nothing more.
ok(near(gapRec.sim.totals.injections, gapRec.gap.amount),
  'the top-up in the ledger equals the gap and no more', gapRec.sim.totals.injections.toFixed(2));
const noGap = F.simulate(plan, asOf, Object.assign({}, RECOPTS, { weeklyVariable: 0 }));
ok(near(gapRec.zero.ending, noGap.ending),
  'sizing the gap does not itself change the window', gapRec.zero.ending.toFixed(2));
// Income totals are untouched by the recovery machinery.
ok(near(gapRec.sim.totals.confirmedIncome, noGap.totals.confirmedIncome),
  'confirmed income is identical with and without the recovery model',
  gapRec.sim.totals.confirmedIncome.toFixed(2));
ok(near(gapRec.sim.totals.estimatedIncome, noGap.totals.estimatedIncome),
  'estimated income is identical with and without the recovery model',
  gapRec.sim.totals.estimatedIncome.toFixed(2));

// --- 4. reconciles to an independent full-ledger calculation -------------
// Rebuilt from scratch below — its own day loop, not simulate() — so agreement
// is real evidence and not the same code checking itself.
function bruteLedger(weekly) {
  const events = F.expandEvents(plan, asOf, gapRec.sim.end, RECOPTS);
  let bal = F.startingCashAmount(plan), min = Infinity;
  let minDate = null;
  for (let i = 0; i < plan.windowDays; i++) {
    const date = F.addDays(asOf, i);
    const measured = date >= gapRec.gap.date;
    if (date === gapRec.gap.date) bal += gapRec.gap.amount;
    for (const e of events) {
      if (e.date !== date || e.kind === 'noncash' || e.jointCash === false) continue;
      bal += e.amount;
      if (measured && bal < min) { min = bal; minDate = date; }
    }
    if (date >= gapRec.effectiveFrom) bal -= weekly / 7;
    if (measured && bal < min) { min = bal; minDate = date; }
  }
  return { min, minDate, ending: bal };
}
let bLo = 0, bHi = 5;
while (bruteLedger(bHi).min >= 500 - 0.005) { bLo = bHi; bHi *= 2; if (bHi > 80000) break; }
while (bHi - bLo > 5) {
  const mid = Math.round((bLo + bHi) / 10) * 5;
  if (bruteLedger(mid).min >= 500 - 0.005) bLo = mid; else bHi = mid;
}
ok(bLo === gapRec.weekly, 'brute-force full ledger agrees with the engine', `$${bLo} vs $${gapRec.weekly}`);
ok(near(bruteLedger(gapRec.weekly).ending, gapRec.sim.ending),
  'and agrees on the ending cash', bruteLedger(gapRec.weekly).ending.toFixed(2));

// --- 5. every measured day respects the buffer ---------------------------
const measuredDays = gapRec.sim.daily.filter(p => p.date >= gapRec.gap.date);
const worst = measuredDays.reduce((a, p) => p.balance < a.balance ? p : a, measuredDays[0]);
ok(gapRec.holds && worst.balance >= 500 - 0.005,
  'every day from the funding date on holds the buffer', `low ${worst.balance.toFixed(2)} on ${worst.date}`);
ok(measuredDays.length === F.diffDays(gapRec.gap.date, gapRec.sim.end) + 1,
  'the measured stretch runs to the end of the window', `${measuredDays.length} days`);

// --- 6. the answer is binding ---------------------------------------------
ok(gapRec.bindingIsReal, 'one $5 step up breaches the buffer — the cap is binding',
  `${gapRec.binding.balance.toFixed(2)} on ${gapRec.binding.date}`);
ok(gapRec.binding.date > gapRec.gap.date, 'the binding day is after the funding date', gapRec.binding.date);
}

// --- 7. the epsilon that used to answer $0 --------------------------------
// Covering the gap lands the balance on exactly the buffer, which in floating
// point is a hair under it. Compared with a bare `<` that reads as a breach
// and the recommender returns $0. Invented case: $1,000.30 opening, one
// confirmed $500.30 bill on day 2, $500 buffer. By hand the low is exactly
// $500.00 — on the buffer, not under it. The fixture is checked first: the
// float really does land BELOW 500, or the case would not reach the epsilon.
const bufferCase = (opening, bill, buffer) => ({ windowDays: 10, defaults: { targetBuffer: buffer },
  startingCash: { amount: opening }, income: [], obligations: [], bills: [],
  commitments: [{ id: 'invented-bill', date: '2026-01-02', amount: bill, label: 'invented bill', confirmed: true }] });
const bufferSim = (opening, bill, buffer) =>
  F.simulate(bufferCase(opening, bill, buffer), '2026-01-01', { weeklyVariable: 0, targetBuffer: buffer });
{
  const exactSim = bufferSim(1000.3, 500.3, 500);
  ok(exactSim.min.balance < 500 && 500 - exactSim.min.balance < 1e-9,
    'the float really lands a fraction of a cent under the $500 buffer',
    exactSim.min.balance.toFixed(15));
  ok(exactSim.breachesBuffer === false,
    'a balance exactly at the buffer is not read as a breach');
  ok(exactSim.weeks.every(w => w.belowBuffer === false),
    'and no week is flagged below the buffer');
  ok(exactSim.shortfall === 0 && exactSim.additionalCashRequired === 0,
    'shortfall and additional cash required are $0 on the same run');
  ok(F.planStatus({ weekly: 0, sim: exactSim }, { sim: exactSim }).id === 'onPlan',
    'the status band reads on plan, agreeing with breachesBuffer');
  ok(F.below(exactSim.min.balance, 500) === false,
    'the page helper Forecast.below agrees (calendar and score table)');

  // One cent under the buffer is a real breach and must stay one.
  // By hand: 1000.30 − 500.31 = 499.99, one cent under $500.
  const centSim = bufferSim(1000.3, 500.31, 500);
  ok(centSim.breachesBuffer === true, 'a one-cent breach of the buffer is still a breach',
    centSim.min.balance.toFixed(2));
  ok(centSim.weeks.some(w => w.belowBuffer === true), 'and its week is flagged below the buffer');
  ok(F.planStatus({ weekly: 0, sim: centSim }, { sim: centSim }).id === 'belowBuffer',
    'the status band reads below buffer on the same run');
  ok(F.below(499.99, 500) === true, 'Forecast.below reports a one-cent breach');

  // At a $0 buffer the same one cent is overdrawn: breach AND shortfall.
  // By hand: 500.30 − 500.31 = −0.01.
  const overSim = bufferSim(500.3, 500.31, 0);
  ok(overSim.breachesBuffer === true && near(overSim.shortfall, 0.01, 0.0001)
    && near(overSim.additionalCashRequired, 0.01, 0.0001),
    'a one-cent overdraft at a $0 buffer is a breach with a $0.01 shortfall',
    `${overSim.breachesBuffer} / ${overSim.shortfall.toFixed(4)}`);

  // Float noise at a $0 buffer: 0.3 − 0.1 − 0.2 lands at about −2.8e-17.
  const noiseSim = F.simulate({ windowDays: 10, defaults: { targetBuffer: 0 },
    startingCash: { amount: 0.3 }, income: [], obligations: [], bills: [],
    commitments: [{ id: 'a', date: '2026-01-02', amount: 0.1, label: 'a', confirmed: true },
      { id: 'b', date: '2026-01-02', amount: 0.2, label: 'b', confirmed: true }] },
  '2026-01-01', { weeklyVariable: 0, targetBuffer: 0 });
  ok(noiseSim.breachesBuffer === false,
    'sub-cent float noise under a $0 buffer is not a buffer breach',
    String(noiseSim.min.balance));
}

// --- 8. the ledger identity survives gap funding ------------------------
// The displayed rows must add up to the ending balance. With an injection in
// the arithmetic and not on the page they reconciled to $3,946.04 against an
// ending of $4,989.20 — an auditable identity that did not audit.
{
  const T = gapRec.sim.totals;
  const rows = F.startingCashAmount(plan) + T.confirmedIncome + T.estimatedIncome + T.injections
    - T.obligations - T.bills - T.commitments - T.variable - (T.reserved || 0) - T.extra;
  ok(near(rows, gapRec.sim.ending),
    'the ledger rows reconcile to the ending balance once gap funding is one of them',
    `${rows.toFixed(2)} = ${gapRec.sim.ending.toFixed(2)}`);
  ok(near(T.injections, Math.max(0, gapRec.gap ? gapRec.gap.amount : 0)),
    'the injection equals the gap (or zero when there is none)', T.injections.toFixed(2));
  const without = rows - T.injections;
  ok(near(Math.abs(without - gapRec.sim.ending), T.injections),
    'leaving the injection out disagrees by exactly that amount',
    `${without.toFixed(2)} vs ${gapRec.sim.ending.toFixed(2)}`);
}

// --- 9. a same-day injection lifts the opening seed ----------------------
// Hand-computed. Opening $100, a $40 bill on as-of, a $80 top-up on as-of.
// Deposits land first: 100 + 80 − 40 = 140. The pre-injection $100 is not
// the measured floor — that was the $0/week recovery when the gap day is
// the cutover itself.
{
  const tiny = {
    windowDays: 7,
    defaults: { targetBuffer: 140 },
    startingCash: { breakdown: [{ id: 'a', value: 100, class: 'spendable' }] },
    income: [], obligations: [], bills: [],
    commitments: [{ id: 'due', date: '2026-08-16', amount: 40, label: 'due' }],
  };
  const day = '2026-08-16';
  const funded = F.simulate(tiny, day, {
    weeklyVariable: 0, targetBuffer: 140, measureFrom: day,
    injections: [{ date: day, amount: 80, id: 'gapFunding', label: 'top-up' }],
  });
  const bare = F.simulate(tiny, day, { weeklyVariable: 0, targetBuffer: 140 });
  ok(near(bare.min.balance, 60),
    'without the top-up the floor is opening minus the bill',
    bare.min.balance.toFixed(2));
  ok(near(funded.min.balance, 140) && near(funded.daily[0].balance, 140),
    'the same-day top-up lifts the seed so the day closes on 100 + 80 − 40',
    funded.min.balance.toFixed(2));
  ok(near(funded.weeks[0].opening, 100),
    'the displayed week opening stays at unfunded cash so the ledger still counts the injection',
    funded.weeks[0].opening.toFixed(2));
  ok(near(funded.weeks[0].low, 140) && funded.weeks[0].belowBuffer === false,
    'week 1 low uses the post-injection boundary, not the unfunded opening',
    funded.weeks[0].low.toFixed(2));
}

console.log('\n=== 10. a buffer above live opening does not shade a funded week 1 ===');
// Independent: opening $2,252.76, buffer $2,500, same-day top-up of the gap.
// sim.min is $2,500 after the injection. Week 1 must not keep the unfunded
// $2,252.76 as its low and flag belowBuffer.
{
  const OPENING = 2252.76;
  const BUFFER = 2500;
  const GAP = BUFFER - OPENING;
  const plan = {
    windowDays: 7,
    defaults: { targetBuffer: BUFFER },
    startingCash: { breakdown: [{ id: 'a', value: OPENING, class: 'spendable' }] },
    income: [], obligations: [], bills: [], commitments: [],
  };
  const day = '2026-08-16';
  const funded = F.simulate(plan, day, {
    weeklyVariable: 0, targetBuffer: BUFFER, measureFrom: day,
    injections: [{ date: day, amount: GAP, id: 'gapFunding', label: 'top-up' }],
  });
  ok(near(GAP, 247.24), 'independent gap is $2,500 − $2,252.76', GAP.toFixed(2));
  ok(near(funded.min.balance, BUFFER),
    'the recommendation floor is the funded buffer', funded.min.balance.toFixed(2));
  ok(near(funded.weeks[0].opening, OPENING),
    'week 1 still opens at the unfunded cash for the ledger',
    funded.weeks[0].opening.toFixed(2));
  ok(near(funded.weeks[0].low, BUFFER) && funded.weeks[0].belowBuffer === false,
    'week 1 low is the post-injection $2,500, not the unfunded $2,252.76',
    funded.weeks[0].low.toFixed(2));
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
