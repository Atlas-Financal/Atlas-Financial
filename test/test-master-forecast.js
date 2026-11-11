'use strict';
/* B94 / AF-PLAN-01 — Forecast is the one master plan.
 * Views are slices. Proofs below are independent of the helper under test
 * wherever a figure is asserted: they rebuild the ledger or the remaining
 * cash from the fixture inputs.
 *
 * `node test/test-master-forecast.js`
 */
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const AS_OF = '2026-08-16';
const JAN = '2027-01-15';

function barePlan(extra) {
  return Object.assign({
    windowDays: 160,
    defaults: { targetBuffer: 500 },
    startingCash: { amount: 8000 },
    income: [],
    obligations: [],
    bills: [],
    commitments: [],
  }, extra || {});
}

function recOpts(extra) {
  return Object.assign({
    scenario: 'expected', incomeOverrides: {}, disabled: [],
    extraDebtMonthly: 0, targetBuffer: 500,
  }, extra || {});
}

console.log('=== knowledge horizon is not the 91-day view ===');
{
  const plan = barePlan({
    windowDays: 7,
    commitments: [
      { id: 'later', label: 'Later cost', date: JAN, amount: 2000, confidence: 'confirmed' },
    ],
  });
  const h = F.knowledgeHorizon(plan, AS_OF, {});
  ok(h.days >= 365, 'every plan knows at least 12 months, even with no recurring streams and a 7-day view',
    `${h.days} days`);
  ok(h.end >= JAN, 'the January commitment sits inside that knowledge, not past it', h.end);

  const farDate = F.addDays(AS_OF, 400);
  const far = F.knowledgeHorizon(barePlan({
    windowDays: 14,
    commitments: [
      { id: 'far', label: 'Beyond a year', date: farDate, amount: 1, confidence: 'confirmed' },
    ],
  }), AS_OF, {});
  ok(far.days === 401 && far.end === farDate,
    'a dated commitment beyond 12 months extends knowledge past 365 days',
    `${far.days} days end=${far.end}`);
}

{
  const live = require('../data.json');
  const h = F.knowledgeHorizon(live.plan, live.meta.asOf, {});
  ok(h.days >= 365, 'the live plan knows at least 12 months',
    String(h.days));
  ok(live.plan.windowDays === 91, 'live windowDays stays the 91-day view', String(live.plan.windowDays));
}

console.log('\n=== January 2027 commitment reduces August 2026 safe-to-spend ===');
{
  const days = 160;
  const start = 8000;
  const buffer = 500;
  const laterAmt = 2000;
  const base = barePlan({
    windowDays: days,
    startingCash: { amount: start },
    defaults: { targetBuffer: buffer },
  });
  const withLater = Object.assign({}, base, {
    commitments: [
      { id: 'later', label: 'January cost', date: JAN, amount: laterAmt, confidence: 'confirmed' },
    ],
  });
  const without = F.recommend(base, AS_OF, recOpts());
  const withC = F.recommend(withLater, AS_OF, recOpts());
  const short = F.recommend(withLater, AS_OF, recOpts({ viewDays: 7 }));
  const withDays = F.knowledgeHorizon(withLater, AS_OF, {}).days;
  const withoutDays = F.knowledgeHorizon(base, AS_OF, {}).days;

  // Independent: only variable spend, so the last day binds.
  // Knowledge is at least 12 months even with no recurring streams.
  // W ≤ (start − lumps − buffer) × 7 / knowledgeDays, snapped down to $5.
  const rawWithout = (start - buffer) * 7 / withoutDays;
  const wantWithout = Math.floor(rawWithout / 5) * 5;
  ok(without.weekly === wantWithout,
    'without the later commitment, weekly is the independent 365-day drain',
    `$${without.weekly} vs hand $${wantWithout} (raw ${rawWithout.toFixed(4)})`);

  const rawWith = (start - laterAmt - buffer) * 7 / withDays;
  const wantWith = Math.floor(rawWith / 5) * 5;
  ok(withC.weekly === wantWith,
    'with the January commitment, weekly matches the independent reduced drain',
    `$${withC.weekly} vs hand $${wantWith} (raw ${rawWith.toFixed(4)})`);
  ok(withC.weekly < without.weekly,
    'the January commitment reduces August safe-to-spend',
    `$${withC.weekly} < $${without.weekly}`);
  ok(short.weekly === withC.weekly,
    'a 7-day visible view still reports that same reduced weekly',
    `$${short.weekly}`);
  ok(short.knowledge.days === withC.knowledge.days,
    'the short view did not shrink what the plan knows',
    String(short.knowledge.days));
}

console.log('\n=== 7 / 91 / 365-day views share master knowledge and today\'s cap ===');
{
  const plan = barePlan({
    windowDays: 91,
    income: [{
      id: 'pay', label: 'Pay', frequency: 'biweekly', anchor: '2026-08-14',
      amount: 2000, confidence: 'confirmed',
    }],
    commitments: [
      { id: 'later', label: 'January cost', date: JAN, amount: 1500, confidence: 'confirmed' },
    ],
  });
  const a = F.recommend(plan, AS_OF, recOpts({ viewDays: 7 }));
  const b = F.recommend(plan, AS_OF, recOpts({ viewDays: 91 }));
  const c = F.recommend(plan, AS_OF, recOpts({ viewDays: 365 }));
  ok(a.knowledge.days === b.knowledge.days && b.knowledge.days === c.knowledge.days,
    'all three views report the same knowledge horizon',
    String(a.knowledge.days));
  ok(a.knowledge.days >= 365, 'knowledge is at least 12 months across those views',
    String(a.knowledge.days));
  ok(a.weekly === b.weekly && b.weekly === c.weekly,
    'present-day weekly cap is identical across 7 / 91 / 365-day views',
    `$${a.weekly}`);
  const seqA = (a.fundingSequence || []).map(x => x.id).join(',');
  const seqC = (c.fundingSequence || []).map(x => x.id).join(',');
  ok(seqA === seqC && seqA === 'later',
    'funding sequence is the same master sequence, not rebuilt per view', seqA);

  const named = ['week', 'payday', 'month', '13-week', '6-month', '1-year']
    .map(id => F.viewRange(plan, AS_OF, id, {}));
  ok(named.every(v => v.days >= 1 && v.days <= a.knowledge.days && v.start === AS_OF),
    'week / payday / month / 13-week / 6-month / 1-year are slices of the same knowledge');
  const custom = F.viewRange(plan, AS_OF, { start: AS_OF, end: F.addDays(AS_OF, 20) }, {});
  ok(custom.id === 'custom' && custom.days === 21 && custom.start === AS_OF,
    'a custom date range starting today is the same kind of view', `${custom.days} days`);

  const futureStart = '2026-09-01';
  const futureEnd = '2026-09-30';
  const futureView = F.viewRange(plan, AS_OF, { start: futureStart, end: futureEnd }, {});
  ok(futureView.start === futureStart && futureView.end === futureEnd && futureView.days === 30,
    'a custom Sep 1–Sep 30 view keeps its future start, not as-of',
    `${futureView.start}..${futureView.end} (${futureView.days} days)`);
  const sliced = F.recommend(plan, AS_OF, recOpts({
    view: { start: futureStart, end: futureEnd },
  }));
  ok(sliced.view.start === futureStart && sliced.sim.start === futureStart
    && sliced.sim.end === futureEnd && sliced.sim.daily[0].date === futureStart,
    'simulate slices the master walk from the requested start',
    `${sliced.sim.start}..${sliced.sim.end} first=${sliced.sim.daily[0] && sliced.sim.daily[0].date}`);
  ok(sliced.weekly === a.weekly,
    'a future-start custom view does not change today\'s weekly cap',
    `$${sliced.weekly}`);
  const sepIncome = F.addDays(futureStart, 10);
  const planWithDates = Object.assign({}, plan, {
    income: plan.income.concat([
      { id: 'aug-pay', label: 'August only', frequency: 'once', date: '2026-08-20',
        amount: 111, confidence: 'confirmed' },
      { id: 'sep-pay', label: 'September only', frequency: 'once', date: sepIncome,
        amount: 222, confidence: 'confirmed' },
    ]),
  });
  const sepSlice = F.recommend(planWithDates, AS_OF, recOpts({
    view: { start: futureStart, end: futureEnd },
  }));
  ok(sepSlice.sim.events.some(e => e.id === 'sep-pay')
    && !sepSlice.sim.events.some(e => e.id === 'aug-pay'),
    'the September view contains September events and not the August one',
    (sepSlice.sim.events || []).map(e => e.id).join(','));

  // Week 3 of the as-of walk is 2026-08-30..2026-09-05. A Sep 1 start clips
  // that week; an 30 August event is in the original week but out of range.
  const midweekPlan = Object.assign({}, plan, {
    income: plan.income.concat([
      { id: 'aug-30-pay', label: 'Same original week, before the view',
        frequency: 'once', date: '2026-08-30', amount: 333, confidence: 'confirmed' },
      { id: 'sep-3-pay', label: 'Same original week, inside the view',
        frequency: 'once', date: '2026-09-03', amount: 222, confidence: 'confirmed' },
    ]),
  });
  const midweekSlice = F.recommend(midweekPlan, AS_OF, recOpts({
    view: { start: futureStart, end: futureEnd },
  }));
  const firstWeek = (midweekSlice.sim.weeks || [])[0];
  ok(firstWeek && firstWeek.start === futureStart,
    'the first sliced week begins on the requested start, not the original week start',
    firstWeek && `${firstWeek.start}..${firstWeek.end}`);
  ok(firstWeek && near(firstWeek.confirmedIncome, 222),
    'a partial week recomputes confirmed income from in-range events only',
    firstWeek && String(firstWeek.confirmedIncome));
  ok(firstWeek && !(firstWeek.events || []).some(e => e.id === 'aug-30-pay'),
    'the clipped week does not keep an out-of-range event from the original week');
  const implied = firstWeek.opening + firstWeek.confirmedIncome + firstWeek.estimatedIncome
    + firstWeek.injections - firstWeek.obligations - firstWeek.bills
    - firstWeek.commitments - firstWeek.variable - (firstWeek.reserved || 0) - firstWeek.extra;
  ok(firstWeek && near(implied, firstWeek.closing, 0.02),
    'the recomputed partial week still reconciles opening + inflows − outflows to closing',
    firstWeek && `${implied.toFixed(2)} vs ${firstWeek.closing.toFixed(2)}`);
}

console.log('\n=== completing a nearer commitment redirects capacity ===');
{
  const days = 160;
  const start = 4000;
  const buffer = 500;
  const nearAmt = 1000;
  const farAmt = 1000;
  const nearDate = '2026-09-01';
  const planBoth = barePlan({
    windowDays: days,
    startingCash: { amount: start },
    defaults: { targetBuffer: buffer },
    commitments: [
      { id: 'near-item', label: 'Nearer requirement', date: nearDate, amount: nearAmt, confidence: 'confirmed' },
      { id: 'far-item', label: 'Later requirement', date: JAN, amount: farAmt, confidence: 'estimated' },
    ],
  });
  const planNearDone = JSON.parse(JSON.stringify(planBoth));
  planNearDone.commitments[0].settledOn = AS_OF;
  const planNone = barePlan({
    windowDays: days,
    startingCash: { amount: start },
    defaults: { targetBuffer: buffer },
  });

  const both = F.recommend(planBoth, AS_OF, recOpts());
  const after = F.recommend(planNearDone, AS_OF, recOpts());
  const none = F.recommend(planNone, AS_OF, recOpts());

  ok(!(both.fundingSequence || []).some(x => x.id === 'near-item') === false
    && (both.fundingSequence || []).map(x => x.id).join(',') === 'near-item,far-item',
    'sequence is near then far by timing, not by a hard-coded Fusion/Seattle/Indio list',
    (both.fundingSequence || []).map(x => x.id).join(','));
  ok(!(after.fundingSequence || []).some(x => x.id === 'near-item'),
    'settling the nearer item drops it from the sequence');
  ok((after.fundingSequence || []).map(x => x.id).join(',') === 'far-item',
    'the later item remains, without any id special-case',
    (after.fundingSequence || []).map(x => x.id).join(','));

  // Independent weekly with both lumps over the master knowledge horizon.
  const bothDays = both.knowledge.days;
  const rawBoth = (start - nearAmt - farAmt - buffer) * 7 / bothDays;
  const wantBoth = Math.floor(rawBoth / 5) * 5;
  ok(both.weekly === wantBoth, 'weekly with both commitments matches the two-lump drain',
    `$${both.weekly} vs hand $${wantBoth}`);

  const afterDays = F.knowledgeHorizon(planNearDone, AS_OF, {}).days;
  const rawAfter = (start - farAmt - buffer) * 7 / afterDays;
  const wantAfter = Math.floor(rawAfter / 5) * 5;
  ok(after.weekly === wantAfter,
    'after the nearer item is finished, weekly is the remaining later lump, not the empty-plan cap',
    `$${after.weekly} vs hand $${wantAfter}`);
  ok(after.weekly > both.weekly, 'finishing the nearer item frees some weekly capacity');
  ok(after.weekly < none.weekly,
    'that freed capacity does not all become safe-to-spend while the later item remains',
    `$${after.weekly} stays below empty-plan $${none.weekly}`);

  const farBoth = (both.majorPlans || []).find(p => p.id === 'far-item');
  const farAfter = (after.majorPlans || []).find(p => p.id === 'far-item');
  ok(farBoth && farAfter && farAfter.funded,
    'the later commitment stays funded after the redirect');
}

console.log('\n=== overspend of a point amount is a FUNDING GAP, not AT RISK ===');
{
  const days = 60;
  const buffer = 500;
  const need = 1000;
  const due = F.addDays(AS_OF, 40);
  const planAt = start => barePlan({
    windowDays: days,
    startingCash: { amount: start },
    defaults: { targetBuffer: buffer },
    commitments: [
      { id: 'trip', label: 'A trip', date: due, amount: need, confidence: 'confirmed' },
    ],
  });

  const comfortable = planAt(3000);
  const rec = F.recommend(comfortable, AS_OF, recOpts());
  const onTrack = (rec.majorPlans || []).find(p => p.id === 'trip');
  ok(onTrack && onTrack.verdict === 'ON TRACK',
    'at the recommended path the dated plan is ON TRACK',
    onTrack && onTrack.verdict);
  ok(onTrack && onTrack.margin != null && onTrack.margin >= -0.01,
    'ON TRACK carries a dollar margin',
    onTrack && String(onTrack.margin));

  // Independent: 41 days of $300/week before the payment leaves
  // 3000 − (300/7)×41 − 1000 ≈ $243, below the $500 buffer.
  const overspendWeekly = 300;
  const daily = overspendWeekly / 7;
  const daysThroughPay = F.diffDays(AS_OF, due) + 1;
  const afterPay = 3000 - daily * daysThroughPay - need;
  ok(afterPay < buffer,
    'the overspend trajectory is independently below the buffer after the payment',
    afterPay.toFixed(2));
  const overspent = F.majorPlans(comfortable, AS_OF, recOpts({ weeklyVariable: overspendWeekly }))
    .find(p => p.id === 'trip');
  ok(overspent && overspent.verdict === 'FUNDING GAP',
    'authoritative infeasibility on this path is a FUNDING GAP, not AT RISK',
    overspent && overspent.verdict);
  ok(overspent && overspent.margin < 0,
    'the gap is a negative dollar margin',
    overspent && String(overspent.margin));
  ok(near(overspent.margin, afterPay - buffer),
    'the gap matches the independent buffer shortfall after payment',
    `${overspent && overspent.margin} vs ${afterPay - buffer}`);

  const brokeStart = buffer + need - 50; // 1450
  ok(brokeStart - need < buffer, 'independent: even with no variable spend the payment breaches',
    String(brokeStart - need));
  const gap = F.majorPlans(planAt(brokeStart), AS_OF, recOpts({ weeklyVariable: 0 }))
    .find(p => p.id === 'trip');
  ok(gap && gap.verdict === 'FUNDING GAP',
    'when remaining cash cannot cover the need, the verdict is FUNDING GAP',
    gap && gap.verdict);
  ok(gap && gap.margin < 0, 'FUNDING GAP carries a negative dollar margin');
}

console.log('\n=== flexible items may move; non-flexible dates are not rewritten ===');
{
  const hardDate = '2026-10-01';
  const flexDate = '2026-09-01';
  const plan = barePlan({
    windowDays: 80,
    startingCash: { amount: 900 },
    defaults: { targetBuffer: 500 },
    commitments: [
      { id: 'hard-item', label: 'Must hit the date', date: hardDate, amount: 800, confidence: 'confirmed' },
      { id: 'flex-item', label: 'Can move', date: flexDate, amount: 800, confidence: 'estimated', adjustable: true },
    ],
  });
  const seq = F.fundingSequence(plan, AS_OF, {});
  ok(seq.map(x => x.id).join(',') === 'hard-item,flex-item',
    'required items rank before bounded-flex; this is presentation, not a serial allocator',
    seq.map(x => x.id).join(','));
  ok(seq.find(x => x.id === 'hard-item').flexibility === 'required'
    && seq.find(x => x.id === 'flex-item').flexibility === 'bounded-flex',
    'adjustable is bounded-flex, not optional');
  const plans = F.majorPlans(plan, AS_OF, recOpts({ weeklyVariable: 0 }));
  const hard = plans.find(p => p.id === 'hard-item');
  const flex = plans.find(p => p.id === 'flex-item');
  ok(hard && hard.scheduledDate === hardDate && hard.date === hardDate,
    'the non-flexible item keeps its original date');
  ok(hard && hard.deferred === false,
    'a non-flexible item is never marked deferred, even if it is a FUNDING GAP',
    hard && `${hard.verdict} deferred=${hard.deferred}`);
  ok(flex && flex.date === flexDate,
    'flexibility does not invent a new date for the flexible item either');
  ok(flex && (flex.verdict !== 'ON TRACK' ? flex.deferred === true : true),
    'a flexible item that is not ON TRACK may be marked deferred');
  const events = F.expandEvents(plan, AS_OF, hardDate, {});
  ok(events.some(e => e.id === 'hard-item' && e.date === hardDate),
    'expandEvents still emits the non-flexible item on its original date');
}

console.log('\n=== no planned debt unless explicitly permitted ===');
{
  const plan = barePlan({
    windowDays: 40,
    startingCash: { amount: 600 },
    defaults: { targetBuffer: 500 },
    income: [{
      id: 'keep-horizon', label: 'Horizon marker', frequency: 'monthly',
      anchor: '2026-08-01', amount: 0, confidence: 'confirmed',
    }],
    commitments: [
      { id: 'gap-item', label: 'Unfunded', date: F.addDays(AS_OF, 20), amount: 2000, confidence: 'confirmed' },
    ],
  });
  const advice = F.recommend(plan, AS_OF, recOpts());
  ok(advice.plannedDebt && advice.plannedDebt.permitted === false
    && advice.plannedDebt.borrowed === 0,
    'default recommend invents no permission to borrow',
    JSON.stringify(advice.plannedDebt && { permitted: advice.plannedDebt.permitted, borrowed: advice.plannedDebt.borrowed }));
  ok(!(advice.simOptions && (advice.simOptions.injections || []).some(i => i.debtId)),
    'default path introduces no planned-debt injection');

  const facility = { id: 'card-x', label: 'A card', rate: 19.99, balance: 100, pending: 50, limit: 5000 };
  const laterPay = F.addDays(F.addDays(AS_OF, 20), 5);
  const planAffordable = Object.assign({}, plan, {
    income: plan.income.concat([{
      id: 'later-cover', label: 'Later cover', frequency: 'once', date: laterPay,
      amount: 2500, confidence: 'confirmed',
    }]),
  });
  const unnamed = F.plannedDebt(plan, AS_OF, recOpts({
    allowPlannedDebt: true,
    plannedDebtFacility: 'card-x',
    debts: [facility],
    weeklyVariable: 0,
  }));
  ok(unnamed.borrowed === 0 && unnamed.feasible === false,
    'allowPlannedDebt alone does not silently finance every gap; purposes must be named',
    JSON.stringify({ borrowed: unnamed.borrowed, feasible: unnamed.feasible }));

  const permitted = F.plannedDebt(planAffordable, AS_OF, recOpts({
    allowPlannedDebt: true,
    plannedDebtFacility: 'card-x',
    plannedDebtPurposes: ['gap-item'],
    debts: [facility],
    weeklyVariable: 0,
  }));
  const due = F.addDays(AS_OF, 20);
  const afterPay = 600 - 2000;
  const wantBorrowed = 500 - afterPay; // 1900 to land on the buffer
  ok(permitted.permitted === true && near(permitted.borrowed, wantBorrowed) && wantBorrowed > 0,
    'when borrowing is explicitly permitted and purpose-named, the draw is the independent buffer gap',
    `$${permitted.borrowed} vs hand $${wantBorrowed}`);
  ok(permitted.draws && permitted.draws.length === 1 && permitted.draws[0].id === 'gap-item'
    && permitted.draws[0].date === due,
    'the draw is purpose-specific and lands on the commitment date',
    JSON.stringify(permitted.draws));
  ok(permitted.feasible === false,
    'a draw without a repayment cadence is not a proven post-financing plan');
  ok(permitted.capacity === 4850,
    'capacity is limit − (posted + pending), not posted alone',
    String(permitted.capacity));
  const unknownPending = F.plannedDebt(planAffordable, AS_OF, recOpts({
    allowPlannedDebt: true,
    plannedDebtFacility: 'card-x',
    plannedDebtPurposes: ['gap-item'],
    debts: [{ id: 'card-x', label: 'A card', rate: 19.99, balance: 100, pendingUnknown: true, limit: 5000 }],
    weeklyVariable: 0,
  }));
  ok(unknownPending.capacity === 0 && unknownPending.borrowed === 0,
    'unknown pending is not treated as $0 usable room',
    String(unknownPending.capacity));

  const withPay = F.plannedDebt(planAffordable, AS_OF, recOpts({
    allowPlannedDebt: true,
    plannedDebtFacility: 'card-x',
    plannedDebtPurposes: ['gap-item'],
    debts: [facility],
    plannedDebtPayment: 100,
    weeklyVariable: 0,
  }));
  ok(withPay.repayment && withPay.repayment.monthlyPayment === 100
    && withPay.repayment.months > 0 && withPay.repayment.flows > 0,
    'repayment cash flows are inserted into the same projection, not only described',
    withPay.repayment && `${withPay.repayment.months} months, ${withPay.repayment.flows} flows`);
  ok(withPay.feasible === true,
    'with a stated cadence and later income covering the payments, the post-financing walk holds');
  ok(withPay.interest < permitted.interest,
    'interest responds to the repayment path: paying down costs less interest than holding the draw',
    `${withPay.interest.toFixed(4)} < ${permitted.interest.toFixed(4)}`);
  ok(withPay.endingBalance != null && permitted.endingBalance != null
    && withPay.endingBalance < permitted.endingBalance,
    'future facility balance is carried on the same path and falls when repayments land',
    `${withPay.endingBalance.toFixed(2)} < ${permitted.endingBalance.toFixed(2)}`);
  ok(permitted.endingBalance - withPay.endingBalance >= 100 - 1,
    'the balance drop is at least one stated $100 repayment, independently of the interest helper',
    String(permitted.endingBalance - withPay.endingBalance));

  const tight = F.plannedDebt(planAffordable, AS_OF, recOpts({
    allowPlannedDebt: true,
    plannedDebtFacility: 'card-x',
    plannedDebtPurposes: ['gap-item'],
    debts: [{ id: 'card-x', label: 'A card', rate: 19.99, balance: 100, pending: 50, limit: 500 }],
    weeklyVariable: 0,
  }));
  ok(near(tight.borrowed, 350) && tight.borrowed < wantBorrowed,
    'a smaller facility cannot over-draw its pending-aware capacity',
    `$${tight.borrowed} capacity $${tight.capacity}`);
  ok(tight.feasible === false,
    'an under-capacity draw is not reported as a feasible post-financing plan');

  const cashCovered = Object.assign({}, plan, {
    startingCash: { amount: 4000 },
    commitments: [
      { id: 'gap-item', label: 'Covered from cash', date: F.addDays(AS_OF, 20),
        amount: 1000, confidence: 'confirmed' },
    ],
  });
  const noAmount = F.plannedDebt(cashCovered, AS_OF, recOpts({
    allowPlannedDebt: true,
    plannedDebtFacility: 'card-x',
    plannedDebtPurposes: ['gap-item'],
    debts: [facility],
    weeklyVariable: 0,
  }));
  ok(noAmount.borrowed === 0,
    'a named purpose that is already cash-feasible is not financed without an authorized amount',
    String(noAmount.borrowed));
  const authorized = F.plannedDebt(cashCovered, AS_OF, recOpts({
    allowPlannedDebt: true,
    plannedDebtFacility: 'card-x',
    plannedDebtPurposes: ['gap-item'],
    plannedDebtAmounts: { 'gap-item': 300 },
    debts: [facility],
    plannedDebtPayment: 50,
    weeklyVariable: 0,
  }));
  ok(near(authorized.borrowed, 300),
    'an explicit authorized amount may finance a named purpose even when cash already covers it',
    `$${authorized.borrowed}`);
  ok(authorized.draws && authorized.draws[0] && authorized.draws[0].id === 'gap-item',
    'the authorized draw stays purpose-specific');

  const nearLimit = { id: 'card-x', label: 'A card', rate: 19.99, balance: 495, pending: 0, limit: 500 };
  const overThenUnder = F.plannedDebt(planAffordable, AS_OF, recOpts({
    allowPlannedDebt: true,
    plannedDebtFacility: 'card-x',
    plannedDebtPurposes: ['gap-item'],
    debts: [nearLimit],
    plannedDebtPayment: 100,
    weeklyVariable: 0,
  }));
  // Independent: daily interest on $495 at 19.99% crosses $500 in
  // 5 / (495 × 0.1999 / 365) ≈ 18.5 days, inside this 40-day walk.
  const dailyInterest = 495 * 0.1999 / 365;
  const daysToCross = (500 - 495) / dailyInterest;
  ok(daysToCross < 40,
    'independent interest path on the $495 opening crosses the $500 limit inside the walk',
    `${daysToCross.toFixed(2)} days at $${dailyInterest.toFixed(4)}/day`);
  ok(overThenUnder.borrowed > 0,
    'a near-limit facility still draws its remaining pending-aware capacity',
    String(overThenUnder.borrowed));
  ok(overThenUnder.endingBalance != null && overThenUnder.endingBalance <= 500 + 0.01,
    'ending balance can finish at or under the limit after repayment',
    String(overThenUnder.endingBalance));
  ok(overThenUnder.feasible === false,
    'an interim over-limit crossing is not a feasible plan even when the ending balance is under',
    `feasible=${overThenUnder.feasible} ending=${overThenUnder.endingBalance}`);
}

console.log('\n=== HELOC limit is a planning boundary, not cash (B70) ===');
{
  // Independent capacity is limit − (posted + pending), never negative, never
  // cash. facilityCapacity is not exported; plannedDebt.capacity is that same
  // bounded headroom, and borrowed may not exceed it.
  const independentCapacity = facility => {
    if (facility.pendingUnknown === true || facility.unknownPending === true) return 0;
    return Math.max(0, (Number(facility.limit) || 0) - (facility.balance + (facility.pending || 0)));
  };
  const laterPay = F.addDays(F.addDays(AS_OF, 20), 5);
  const planAffordable = barePlan({
    windowDays: 40,
    startingCash: { amount: 600 },
    defaults: { targetBuffer: 500 },
    income: [{
      id: 'keep-horizon', label: 'Horizon marker', frequency: 'monthly',
      anchor: '2026-08-01', amount: 0, confidence: 'confirmed',
    }, {
      id: 'later-cover', label: 'Later cover', frequency: 'once', date: laterPay,
      amount: 2500, confidence: 'confirmed',
    }],
    commitments: [
      { id: 'gap-item', label: 'Unfunded', date: F.addDays(AS_OF, 20), amount: 2000, confidence: 'confirmed' },
    ],
  });

  // A. zero headroom — posted equals limit, and posted+pending equals limit.
  const atPostedLimit = { id: 'heloc', label: 'HELOC', rate: 4.90, balance: 202654, pending: 0, limit: 202654 };
  const atUsedLimit = { id: 'heloc', label: 'HELOC', rate: 4.90, balance: 200000, pending: 2654, limit: 202654 };
  ok(independentCapacity(atPostedLimit) === 0 && independentCapacity(atUsedLimit) === 0,
    'independent: posted=limit and posted+pending=limit both leave $0 headroom');
  for (const facility of [atPostedLimit, atUsedLimit]) {
    const zero = F.plannedDebt(planAffordable, AS_OF, recOpts({
      allowPlannedDebt: true,
      plannedDebtFacility: 'heloc',
      plannedDebtPurposes: ['gap-item'],
      debts: [facility],
      plannedDebtPayment: 100,
      weeklyVariable: 0,
    }));
    ok(zero.capacity === 0 && near(zero.borrowed, 0),
      'A: at the HELOC limit, facilityCapacity is $0 and plannedDebt.borrowed is $0',
      `${facility.balance}+${facility.pending} capacity=${zero.capacity} borrowed=${zero.borrowed}`);
    ok((zero.draws || []).length === 0,
      'A: $0 headroom cannot create another draw',
      JSON.stringify(zero.draws));
  }

  // B. credit is not cash — unused HELOC headroom alone does not raise
  // starting cash or recommend weekly (safe-to-spend) without authorization.
  const cashPlan = barePlan({
    windowDays: 160,
    startingCash: { amount: 8000 },
    defaults: { targetBuffer: 500 },
    income: [{
      id: 'keep-horizon', label: 'Horizon marker', frequency: 'monthly',
      anchor: '2026-08-01', amount: 0, confidence: 'confirmed',
    }],
  });
  const unusedHeloc = { id: 'heloc', label: 'HELOC', rate: 4.90, balance: 100000, pending: 0, limit: 202654 };
  ok(independentCapacity(unusedHeloc) === 102654,
    'independent: unused HELOC headroom on this fixture is $102,654',
    String(independentCapacity(unusedHeloc)));
  const recCashOnly = F.recommend(cashPlan, AS_OF, recOpts());
  const recWithHeadroom = F.recommend(cashPlan, AS_OF, recOpts({ debts: [unusedHeloc] }));
  ok(F.startingCashAmount(cashPlan) === 8000,
    'B: starting cash is the cash opening, not credit headroom',
    String(F.startingCashAmount(cashPlan)));
  ok(recCashOnly.weekly === recWithHeadroom.weekly,
    'B: unused HELOC headroom does not increase Forecast.recommend weekly',
    `$${recCashOnly.weekly} vs $${recWithHeadroom.weekly}`);
  const weeks = recCashOnly.knowledge.days / 7;
  const rawWeekly = (8000 - 500) / weeks;
  const wantWeekly = Math.floor(rawWeekly / 5) * 5;
  ok(recCashOnly.weekly === wantWeekly && recWithHeadroom.weekly === wantWeekly,
    'B: weekly matches the independent cash-only drain, with or without unused HELOC room',
    `$${recWithHeadroom.weekly} vs hand $${wantWeekly} (raw ${rawWeekly.toFixed(4)})`);
  ok(recCashOnly.plannedDebt.permitted === false && recWithHeadroom.plannedDebt.borrowed === 0,
    'B: recommend does not authorize or draw that unused headroom');

  // C. no unapproved repair — an otherwise infeasible protected plan stays
  // infeasible when a HELOC exists but allowPlannedDebt is false.
  const due = F.addDays(AS_OF, 9);
  const infeasiblePlan = barePlan({
    windowDays: 40,
    startingCash: { amount: 1400 },
    defaults: { targetBuffer: 500 },
    income: [{
      id: 'keep-horizon', label: 'Horizon marker', frequency: 'monthly',
      anchor: '2026-08-01', amount: 0, confidence: 'confirmed',
    }, {
      id: 'after-deadline', label: 'Pay after deadline', frequency: 'once',
      date: F.addDays(AS_OF, 14), amount: 5000, confidence: 'confirmed',
    }],
    commitments: [{
      id: 'dated-range', label: 'A dated range', date: due,
      amount: null, amountMin: 1000, amountMax: 2000, confidence: 'estimated',
    }],
  });
  // Independent: surplus on due at W=0 is 1400 − 500 = 900; floor 1000; short $100.
  ok(1400 - 500 === 900 && 900 < 1000,
    'independent: the protected dated-range floor is short $100 with no borrowing');
  const recBare = F.recommend(infeasiblePlan, AS_OF, recOpts());
  const recHelocDenied = F.recommend(infeasiblePlan, AS_OF, recOpts({
    debts: [{ id: 'heloc', label: 'HELOC', rate: 4.90, balance: 0, pending: 0, limit: 202654 }],
    allowPlannedDebt: false,
  }));
  ok(recBare.mode === 'infeasible' && recBare.weekly === 0 && recBare.holds === false,
    'C: the protected plan is infeasible with no HELOC present',
    `${recBare.mode} weekly=${recBare.weekly}`);
  ok(recHelocDenied.mode === 'infeasible' && recHelocDenied.weekly === 0
    && recHelocDenied.holds === false,
    'C: an unauthorized HELOC does not repair that infeasibility',
    `${recHelocDenied.mode} weekly=${recHelocDenied.weekly} borrowed=${recHelocDenied.plannedDebt.borrowed}`);
  ok(recHelocDenied.plannedDebt.permitted === false && recHelocDenied.plannedDebt.borrowed === 0,
    'C: allowPlannedDebt false invents neither permission nor a draw');

  // D. authorized borrowing is still bounded by remaining headroom.
  const thinHeloc = { id: 'heloc', label: 'HELOC', rate: 4.90, balance: 202000, pending: 0, limit: 202654 };
  const wantRoom = independentCapacity(thinHeloc);
  ok(wantRoom === 654, 'independent: remaining HELOC headroom is $654', String(wantRoom));
  const bounded = F.plannedDebt(planAffordable, AS_OF, recOpts({
    allowPlannedDebt: true,
    plannedDebtFacility: 'heloc',
    plannedDebtPurposes: ['gap-item'],
    debts: [thinHeloc],
    plannedDebtPayment: 100,
    weeklyVariable: 0,
  }));
  const afterPay = 600 - 2000;
  const cashGap = 500 - afterPay; // 1900, larger than remaining room
  ok(cashGap > wantRoom,
    'independent: the named purpose wants more than remaining HELOC room',
    `cash gap $${cashGap} vs room $${wantRoom}`);
  ok(near(bounded.capacity, wantRoom) && near(bounded.borrowed, wantRoom)
    && bounded.borrowed <= wantRoom,
    'D: with allowPlannedDebt and a named purpose, the draw is capped at remaining headroom',
    `borrowed $${bounded.borrowed} capacity $${bounded.capacity}`);

  // E. interim crossing fails — isolate the limit walk from the cash gap.
  // Cash already covers the named purpose; an authorized $5 draw lands on the
  // limit; capitalised interest is then over-limit; a $100 repayment can still
  // finish under. Feasible must still be false.
  const cashCoveredHeloc = Object.assign({}, planAffordable, {
    startingCash: { amount: 4000 },
    commitments: [
      { id: 'gap-item', label: 'Covered from cash', date: F.addDays(AS_OF, 20),
        amount: 1000, confidence: 'confirmed' },
    ],
  });
  const nearHelocLimit = { id: 'heloc', label: 'HELOC', rate: 4.90, balance: 495, pending: 0, limit: 500 };
  const overThenUnderHeloc = F.plannedDebt(cashCoveredHeloc, AS_OF, recOpts({
    allowPlannedDebt: true,
    plannedDebtFacility: 'heloc',
    plannedDebtPurposes: ['gap-item'],
    plannedDebtAmounts: { 'gap-item': 5 },
    debts: [nearHelocLimit],
    plannedDebtPayment: 100,
    weeklyVariable: 0,
  }));
  const drawn = independentCapacity(nearHelocLimit);
  const afterDraw = 495 + drawn;
  const dailyHelocInterest = afterDraw * 0.049 / 365;
  ok(drawn === 5 && afterDraw === 500 && dailyHelocInterest > 0,
    'independent: drawing remaining $5 lands on the $500 limit; the next capitalised interest is over-limit',
    `$${dailyHelocInterest.toFixed(4)}/day after draw`);
  ok(near(overThenUnderHeloc.borrowed, 5),
    'E: the authorized near-limit HELOC draw is remaining pending-aware capacity',
    String(overThenUnderHeloc.borrowed));
  ok(overThenUnderHeloc.endingBalance != null && overThenUnderHeloc.endingBalance <= 500 + 0.01,
    'E: ending balance can finish at or under the limit after repayment',
    String(overThenUnderHeloc.endingBalance));
  ok(overThenUnderHeloc.feasible === false,
    'E: a HELOC walk that crosses the limit is infeasible even when the ending balance is under',
    `feasible=${overThenUnderHeloc.feasible} ending=${overThenUnderHeloc.endingBalance}`);
}

{
  const due = F.addDays(AS_OF, 9);
  const laterIncome = F.addDays(AS_OF, 14);
  const buffer = 500;
  const floor = 1000;
  const start = 1400;
  const plan = barePlan({
    windowDays: 40,
    startingCash: { amount: start },
    defaults: { targetBuffer: buffer },
    income: [{
      id: 'keep-horizon', label: 'Horizon marker', frequency: 'monthly',
      anchor: '2026-08-01', amount: 0, confidence: 'confirmed',
    }, {
      id: 'after-deadline', label: 'Pay after deadline', frequency: 'once',
      date: laterIncome, amount: 5000, confidence: 'confirmed',
    }],
    commitments: [{
      id: 'dated-range', label: 'A dated range', date: due,
      amount: null, amountMin: floor, amountMax: 2000, confidence: 'estimated',
    }],
  });
  // Independent: surplus on due at W=0 is 1400 − 500 = 900; floor 1000; short $100.
  // $5,000 after the deadline repairs ending leftover, not the deadline.
  ok(start - buffer === 900 && 900 < floor,
    'independent: the dated-range floor is short $100 on the due date');
  const miss = F.plannedDebt(plan, AS_OF, recOpts({
    allowPlannedDebt: true,
    plannedDebtFacility: 'card-x',
    plannedDebtPurposes: ['dated-range'],
    debts: [{ id: 'card-x', label: 'A card', rate: 19.99, balance: 0, pending: 0, limit: 50 }],
    plannedDebtPayment: 10,
    weeklyVariable: 0,
  }));
  ok(near(miss.borrowed, 50),
    'an under-capacity draw still borrows the $50 room',
    String(miss.borrowed));
  ok(start + 50 - buffer === 950 && 950 < floor,
    'independent: $50 on the due date still leaves surplus $950 below the $1,000 floor');
  ok(miss.feasible === false,
    'later income after a protected range deadline does not make planned debt feasible',
    `feasible=${miss.feasible} borrowed=${miss.borrowed}`);

  const covers = F.plannedDebt(plan, AS_OF, recOpts({
    allowPlannedDebt: true,
    plannedDebtFacility: 'card-x',
    plannedDebtPurposes: ['dated-range'],
    debts: [{ id: 'card-x', label: 'A card', rate: 19.99, balance: 0, pending: 0, limit: 5000 }],
    plannedDebtPayment: 20,
    weeklyVariable: 0,
  }));
  ok(near(covers.borrowed, 100) && covers.repayment && covers.repayment.flows > 0,
    'a purpose-named $100 draw has a repayment cadence on the longer walk',
    covers.repayment && `${covers.borrowed} borrowed, ${covers.repayment.flows} flows`);
  ok(start + 100 - buffer === floor,
    'independent: $100 on the due date lands surplus on the $1,000 floor');
  ok(covers.feasible === true,
    'planned debt is feasible when the financing path actually fixes the deadline',
    `feasible=${covers.feasible} borrowed=${covers.borrowed} flows=${covers.repayment && covers.repayment.flows}`);
}

console.log('\n=== undated requirements withhold permission; ranges stay ranges ===');
{
  const days = 14;
  const start = 2000;
  const buffer = 500;
  const undated = 1000;
  const plan = barePlan({
    windowDays: days,
    startingCash: { amount: start },
    defaults: { targetBuffer: buffer },
    commitments: [
      { id: 'undated-need', label: 'Known undated cost', amount: undated, confidence: 'confirmed' },
    ],
  });
  const rec = F.recommend(plan, AS_OF, recOpts());
  // Independent: leftover = start − (W/7)×knowledgeDays − buffer ≥ undated.
  const raw = (start - buffer - undated) * 7 / rec.knowledge.days;
  const want = Math.floor(raw / 5) * 5;
  ok(rec.weekly === null,
    'an undated protected requirement withholds weekly permission');
  const datedControl = JSON.parse(JSON.stringify(plan)); datedControl.commitments[0].date = JAN;
  ok(F.recommend(datedControl, AS_OF, recOpts()).weekly === want,
    'a separate invented dated cost keeps the independent reduced-drain oracle');
  ok(rec.knowledge.encumbered === undated,
    'the undated amount is encumbered principal, not free cash',
    String(rec.knowledge.encumbered));
  ok(rec.knowledge.freeCash === null,
    'free cash dependent on the unresolved cash date stays Unknown');
  const row = (rec.majorPlans || []).find(p => p.id === 'undated-need');
  ok(row && row.verdict === null && row.need === undated && row.encumbered === undated,
    'the undated item retains its known price and protection without an affordability verdict');
}

{
  const days = 14;
  const buffer = 500;
  const planBoth = barePlan({
    windowDays: days,
    startingCash: { amount: 2000 },
    defaults: { targetBuffer: buffer },
    commitments: [
      { id: 'a', label: 'First undated', amount: 800, confidence: 'confirmed' },
      { id: 'b', label: 'Second undated', amount: 800, confidence: 'confirmed' },
    ],
  });
  const rec = F.recommend(planBoth, AS_OF, recOpts());
  // The 100 principal shortfall is known, while dates and cash feasibility remain Unknown.
  ok(rec.weekly === null,
    'two required-undated needs withhold weekly permission');
  ok(rec.mode === 'infeasible' && rec.holds === null,
    'known encumbered pressure does not establish cash feasibility without dates',
    `${rec.mode} holds=${rec.holds}`);
  ok(rec.zero && rec.zero.ending === null,
    'the zero-spend cash close remains Unknown while the independent principal shortfall stays visible');
  ok(rec.infeasible && rec.infeasible.kind === 'encumbered'
    && near(rec.infeasible.shortfall, 100),
    'the first failing constraint is the $100 joint encumbered shortfall',
    rec.infeasible && `${rec.infeasible.kind} ${rec.infeasible.shortfall}`);
  ok(rec.infeasible && (rec.infeasible.id === 'a' || rec.infeasible.id === 'b'),
    'the infeasible record names an affected undated commitment',
    rec.infeasible && rec.infeasible.id);
  const plans = rec.majorPlans || [];
  ok(plans.every(p => p.verdict === null && p.need === 800),
    'both undated items keep their known price while dependent verdicts remain Unknown',
    plans.map(p => p.id + ':' + p.verdict).join(','));
}

{
  const days = 14;
  const buffer = 500;
  const rangePlan = (start, extra) => barePlan({
    windowDays: days,
    startingCash: { amount: start },
    defaults: { targetBuffer: buffer },
    commitments: [Object.assign({
      id: 'indio-like', label: 'A ranged cost',
      amount: null, amountMin: 1000, amountMax: 2000, confidence: 'estimated',
    }, extra || {})],
  });
  ok(F.commitmentNeed(rangePlan(3000).commitments[0]) == null,
    'commitmentNeed does not collapse a range to its floor');
  ok(F.scheduledAmountState(rangePlan(3000), AS_OF, JAN).status === 'unavailable',
    'the original undated range withholds cash permission');
  const covered = F.majorPlans(rangePlan(3000, { date: JAN }), AS_OF, recOpts({ weeklyVariable: 0 }))
    .find(p => p.id === 'indio-like');
  ok(covered && covered.need == null && covered.amountMin === 1000 && covered.amountMax === 2000,
    'the published requirement stays a range',
    JSON.stringify(covered && { need: covered.need, min: covered.amountMin, max: covered.amountMax, verdict: covered.verdict }));
  ok(covered.verdict === 'ON TRACK',
    'covering the ceiling as well as the floor is ON TRACK',
    covered && covered.verdict);
  // leftover(0) at 1800 start = 1300. Floor 1000 ok, ceiling 2000 not.
  const risk = F.majorPlans(rangePlan(1800, { date: JAN }), AS_OF, recOpts({ weeklyVariable: 0 }))
    .find(p => p.id === 'indio-like');
  ok(risk && risk.verdict === 'AT RISK',
    'base floor feasible and ceiling not is AT RISK',
    risk && risk.verdict);
  ok(risk.margin > 0, 'AT RISK still reports a positive base margin', String(risk && risk.margin));
  const gap = F.majorPlans(rangePlan(1400, { date: JAN }), AS_OF, recOpts({ weeklyVariable: 0 }))
    .find(p => p.id === 'indio-like');
  ok(gap && gap.verdict === 'FUNDING GAP',
    'missing the floor is a FUNDING GAP, not a collapsed-point AT RISK',
    gap && gap.verdict);

  const rec = F.recommend(rangePlan(1800, { date: JAN }), AS_OF, recOpts());
  const raw = (1800 - buffer - 1000) * 7 / rec.knowledge.days;
  const want = Math.floor(raw / 5) * 5;
  ok(rec.weekly === want,
    'weekly reserves the range floor, not a midpoint or the ceiling',
    `$${rec.weekly} vs hand $${want}`);
}

{
  const due = F.addDays(AS_OF, 9); // 10th calendar day, 2026-08-25
  const laterIncome = F.addDays(AS_OF, 14); // 2026-08-30, after the deadline
  const days = 40;
  const buffer = 500;
  const rangePlan = start => barePlan({
    windowDays: days,
    startingCash: { amount: start },
    defaults: { targetBuffer: buffer },
    income: [{
      id: 'after-deadline', label: 'Pay after deadline', frequency: 'once',
      date: laterIncome, amount: 5000, confidence: 'confirmed',
    }],
    commitments: [{
      id: 'dated-range', label: 'A dated range', date: due,
      amount: null, amountMin: 1000, amountMax: 2000, confidence: 'estimated',
    }],
  });
  const horizon = F.knowledgeHorizon(rangePlan(2000), AS_OF, {});
  ok(horizon.days >= F.diffDays(AS_OF, due) + 1 && horizon.end >= due,
    'a dated range-only row extends the knowledge horizon to its deadline',
    `${horizon.days} days end=${horizon.end}`);
  const covered = F.majorPlans(rangePlan(3500), AS_OF, recOpts({ weeklyVariable: 0 }))
    .find(p => p.id === 'dated-range');
  // Surplus on due date at W=0: 3500 - 500 = 3000, covers ceiling 2000.
  // Structural margin is surplus − ceiling = 1000, not the $3,000 surplus.
  ok(covered && covered.need == null && covered.amountMin === 1000 && covered.amountMax === 2000
    && covered.verdict === 'ON TRACK',
    'dated range stays a range and is ON TRACK when the deadline surplus covers the ceiling');
  ok(covered && near(covered.margin, 3000 - 2000),
    'ON TRACK dated-range margin is surplus minus the ceiling, not the surplus itself',
    covered && String(covered.margin));
  const risk = F.majorPlans(rangePlan(2000), AS_OF, recOpts({ weeklyVariable: 0 }))
    .find(p => p.id === 'dated-range');
  // Surplus on due date: 2000 - 500 = 1500. Floor 1000 ok, ceiling 2000 not.
  // Horizon leftover includes the $5,000 after the deadline and would wrongly pass.
  ok(risk && risk.verdict === 'AT RISK',
    'income after the deadline cannot make a ranged commitment look ceiling-feasible',
    risk && risk.verdict);
  ok(risk && near(risk.margin, 1500 - 1000),
    'AT RISK dated-range margin is the positive base surplus minus floor',
    risk && String(risk.margin));
  ok(risk && near(risk.remaining, 2000 - 1500),
    'AT RISK remaining is the ceiling shortfall, independently 2000 − 1500',
    risk && String(risk.remaining));
  const gap = F.majorPlans(rangePlan(1400), AS_OF, recOpts({ weeklyVariable: 0 }))
    .find(p => p.id === 'dated-range');
  // Surplus on due date: 1400 - 500 = 900 < floor 1000, even though $5,000 arrives later.
  ok(gap && gap.verdict === 'FUNDING GAP',
    'missing the floor by the stated date is a FUNDING GAP despite later income',
    gap && gap.verdict);
  ok(gap && near(gap.margin, 900 - 1000),
    'FUNDING GAP dated-range margin is surplus minus floor (−$100), not the $900 surplus',
    gap && String(gap.margin));
  ok(gap && near(gap.remaining, 100),
    'FUNDING GAP remaining is the independent $100 floor shortfall',
    gap && String(gap.remaining));
  const rec = F.recommend(rangePlan(2000), AS_OF, recOpts());
  // Deadline: 2000 − 10×(W/7) − 500 ≥ 1000 → W ≤ 350.
  // Horizon leftover also holds the $1,000 floor after the later $5,000:
  // W ≤ (2000 + 5000 − 500 − 1000) × 7 / knowledgeDays. The tighter bind wins.
  const deadlineRaw = (2000 - buffer - 1000) * 7 / 10;
  const horizonRaw = (2000 + 5000 - buffer - 1000) * 7 / rec.knowledge.days;
  const wantDated = Math.floor(Math.min(deadlineRaw, horizonRaw) / 5) * 5;
  ok(rec.weekly === wantDated,
    'weekly is the tighter of the range deadline and still-encumbered horizon leftover',
    `$${rec.weekly} vs hand $${wantDated} (deadline ${deadlineRaw.toFixed(2)}, horizon ${horizonRaw.toFixed(2)})`);

  const gapRec = F.recommend(rangePlan(1400), AS_OF, recOpts());
  ok(gapRec.mode === 'infeasible' && gapRec.weekly === 0 && gapRec.holds === false,
    'a dated-range floor gap is INFEASIBLE, not a normal $0/week cap',
    `${gapRec.mode} weekly=${gapRec.weekly} holds=${gapRec.holds}`);
  ok(gapRec.zero && gapRec.zero.min.balance >= buffer,
    'the ordinary cash buffer still holds: the range is not a cash event',
    gapRec.zero && String(gapRec.zero.min.balance));
  ok(gapRec.infeasible && gapRec.infeasible.kind === 'dated-reserve'
    && gapRec.infeasible.date === due && gapRec.infeasible.id === 'dated-range'
    && near(gapRec.infeasible.shortfall, 100),
    'the first failing constraint is the $100 floor shortfall on the stated date',
    gapRec.infeasible && JSON.stringify(gapRec.infeasible));
}

{
  // Recurring streams keep knowledge past the due date, so later weekly
  // spend would otherwise consume still-unsettled dated-range principal.
  const due = F.addDays(AS_OF, 9); // 10 calendar days
  const start = 2000;
  const buffer = 500;
  const floor = 1000;
  const plan = barePlan({
    windowDays: 40,
    startingCash: { amount: start },
    defaults: { targetBuffer: buffer },
    income: [{
      id: 'keep-horizon', label: 'Horizon marker', frequency: 'monthly',
      anchor: '2026-08-01', amount: 0, confidence: 'confirmed',
    }],
    commitments: [{
      id: 'dated-range', label: 'A dated range', date: due,
      amount: null, amountMin: floor, amountMax: 2000, confidence: 'estimated',
    }],
  });
  const rec = F.recommend(plan, AS_OF, recOpts());
  const days = rec.knowledge.days;
  ok(days > 10,
    'knowledge continues past the dated-range due date when streams continue',
    String(days));
  // Deadline-only would allow W ≤ $350. Horizon leftover without the
  // reserve: W ≤ (2000 − 500) × 7 / days. Holding the principal through
  // the whole walk: leftover ≥ 1000 → W ≤ (2000 − 500 − 1000) × 7 / days.
  const wantHeld = Math.floor(((start - buffer - floor) * 7 / days) / 5) * 5;
  const wantUnreserved = Math.floor(((start - buffer) * 7 / days) / 5) * 5;
  ok(rec.weekly === wantHeld,
    'dated-range principal stays encumbered after its due date until settlement',
    `$${rec.weekly} vs held-through-horizon $${wantHeld} (unreserved would be $${wantUnreserved})`);
  ok(rec.knowledge.encumbered === floor,
    'the dated range floor is still-encumbered principal, not free cash after the date',
    String(rec.knowledge.encumbered));
  const empty = F.recommend(barePlan({
    windowDays: 40, startingCash: { amount: start }, defaults: { targetBuffer: buffer },
    income: plan.income,
  }), AS_OF, recOpts());
  ok(rec.weekly < empty.weekly && empty.weekly === wantUnreserved,
    'unsettled dated-range principal still binds today\'s cap after the due date',
    `$${rec.weekly} < empty-plan $${empty.weekly}`);
}

{
  const due = F.addDays(AS_OF, 9);
  const plan = barePlan({
    windowDays: 40,
    startingCash: { amount: 2000 },
    defaults: { targetBuffer: 500 },
    commitments: [
      { id: 'dated-range', label: 'A dated range', date: due,
        amount: null, amountMin: 1000, amountMax: 1000, confidence: 'estimated' },
      { id: 'optional-item', label: 'Optional undated', amount: 1000, optional: true },
    ],
  });
  const plans = F.majorPlans(plan, AS_OF, recOpts({ weeklyVariable: 0 }));
  const optional = plans.find(p => p.id === 'optional-item');
  const leftover = 2000 - 500; // 1500
  const residual = leftover - 1000; // after still-encumbered dated-range floor
  ok(optional && optional.verdict !== 'ON TRACK' && optional.funded === false,
    'optional residual cannot reuse still-encumbered dated-range principal',
    optional && `${optional.verdict} remaining=${optional.remaining}`);
  ok(optional && near(optional.remaining, 1000 - residual),
    'optional residual is leftover after the dated-range floor, not the same $1,000 twice',
    optional && String(optional.remaining));
}

{
  const plan = barePlan({
    windowDays: 14,
    startingCash: { amount: 2000 },
    defaults: { targetBuffer: 500 },
    commitments: [
      { id: 'required-item', label: 'Required undated', amount: 1000, confidence: 'confirmed' },
      { id: 'optional-item', label: 'Optional undated', amount: 1000, optional: true, priority: 1, confidence: 'estimated' },
    ],
  });
  const seq = F.fundingSequence(plan, AS_OF, {});
  ok(seq.map(x => x.id).join(',') === 'required-item,optional-item',
    'owner priority on an optional item cannot rank it ahead of a required one',
    seq.map(x => `${x.id}:${x.flexibility}`).join(','));
  const rec = F.recommend(plan, AS_OF, recOpts());
  const raw = (2000 - 500 - 1000) * 7 / rec.knowledge.days;
  const want = Math.floor(raw / 5) * 5;
  ok(rec.weekly === null && rec.sim.scheduledAmounts.unknowns.some(row => row.id === 'required-item')
    && !rec.sim.scheduledAmounts.unknowns.some(row => row.id === 'optional-item'),
    'the required-undated need withholds permission; optional scope remains exempt');
}

{
  const plan = barePlan({
    windowDays: 14,
    startingCash: { amount: 1800 },
    defaults: { targetBuffer: 500 },
    commitments: [
      { id: 'required-item', label: 'Required undated', amount: 1000, confidence: 'confirmed' },
      { id: 'optional-item', label: 'Optional undated', amount: 1000, optional: true, priority: 1, confidence: 'estimated' },
    ],
  });
  const plans = F.majorPlans(plan, AS_OF, recOpts({ weeklyVariable: 0 }));
  const optional = plans.find(p => p.id === 'optional-item');
  const leftover = 1800 - 500; // 1300
  const residual = leftover - 1000; // 300 after the required floor
  ok(optional && optional.need === 1000,
    'optional keeps its actual $1,000 target rather than a zero protected floor',
    optional && String(optional.need));
  ok(optional && optional.verdict === null && optional.funded === null,
    'an optional item cannot acquire a funded verdict beside a required-undated dependency',
    optional && `${optional.verdict} remaining=${optional.remaining}`);
  ok(optional && optional.remaining === null,
    'optional remaining is Unknown while its required dependency is undated',
    optional && String(optional.remaining));
}

{
  const plan = barePlan({
    windowDays: 14,
    startingCash: { amount: 900 },
    defaults: { targetBuffer: 500 },
    commitments: [
      { id: 'optional-early', label: 'Earlier optional', date: '2026-09-01',
        amount: 400, optional: true, priority: 2, confidence: 'estimated' },
      { id: 'optional-late', label: 'Later optional, owner-ranked higher', date: '2026-12-01',
        amount: 400, optional: true, priority: 1, confidence: 'estimated' },
    ],
  });
  const seq = F.fundingSequence(plan, AS_OF, {});
  ok(seq.map(x => x.id).join(',') === 'optional-late,optional-early',
    'among optional items, owner priority ranks residual ahead of date',
    seq.map(x => `${x.id}:p${x.priority}`).join(','));
  const plans = F.majorPlans(plan, AS_OF, recOpts({ weeklyVariable: 0 }));
  const early = plans.find(p => p.id === 'optional-early');
  const late = plans.find(p => p.id === 'optional-late');
  // leftover = 900 − 500 = 400, enough for exactly one $400 optional.
  ok(late && late.verdict === 'ON TRACK' && late.funded === true,
    'the owner-ranked later optional receives the residual $400',
    late && `${late.verdict} remaining=${late.remaining}`);
  ok(early && early.verdict !== 'ON TRACK' && early.funded === false,
    'the earlier optional does not take residual ahead of the owner-ranked item',
    early && `${early.verdict} remaining=${early.remaining}`);
}

{
  const days = 14;
  const start = 2000;
  const buffer = 500;
  const undated = 1000;
  const plan = barePlan({
    windowDays: days,
    startingCash: { amount: start },
    defaults: { targetBuffer: buffer },
    commitments: [
      { id: 'undated-need', label: 'Known undated cost', amount: undated, confidence: 'confirmed' },
    ],
  });
  const rec = F.recommend(plan, AS_OF, recOpts());
  const row = (rec.majorPlans || []).find(p => p.id === 'undated-need');
  ok(row && row.funded === null && row.remaining === null && row.need === undated,
    'an undated unpaid item preserves its price but cannot claim fully funded');
  const datedControl = JSON.parse(JSON.stringify(plan)); datedControl.commitments[0].date = JAN;
  const datedAdvice = F.recommend(datedControl, AS_OF, recOpts());
  const datedRow = datedAdvice.majorPlans.find(p => p.id === 'undated-need');
  ok(datedRow && datedRow.funded && datedRow.remaining === 0 && !datedControl.commitments[0].settledOn,
    'a separate invented dated positive cost can be fully funded while unpaid');
  const empty = F.recommend(barePlan({
    windowDays: days, startingCash: { amount: start }, defaults: { targetBuffer: buffer },
  }), AS_OF, recOpts());
  ok(datedAdvice.weekly < empty.weekly,
    'the dated funded-unpaid cost still binds permission without becoming free cash');
  const settledPlan = JSON.parse(JSON.stringify(plan));
  settledPlan.commitments[0].settledOn = AS_OF;
  const settled = F.recommend(settledPlan, AS_OF, recOpts());
  ok(settled.weekly === empty.weekly,
    'settlement, not mere funding, releases the encumbered principal',
    `$${settled.weekly} vs empty-plan $${empty.weekly}`);
}

console.log('\n=== overdue unsettled point commitments stay protected ===');
{
  const yesterday = F.addDays(AS_OF, -1);
  const start = 800;
  const buffer = 500;
  const overdueAmt = 400;
  const plan = barePlan({
    windowDays: 14,
    startingCash: { amount: start },
    defaults: { targetBuffer: buffer },
    commitments: [
      { id: 'overdue-item', label: 'Unpaid yesterday', date: yesterday,
        amount: overdueAmt, confidence: 'confirmed' },
    ],
  });
  const rec = F.recommend(plan, AS_OF, recOpts());
  ok((rec.fundingSequence || []).some(x => x.id === 'overdue-item'),
    'the overdue unsettled point commitment remains in the sequence');
  ok(rec.mode === 'infeasible' && rec.holds === false && rec.weekly === 0,
    'cash that cannot cover the overdue obligation is INFEASIBLE, not a spendable weekly cap',
    `${rec.mode} weekly=${rec.weekly} holds=${rec.holds}`);
  // Independent: leftover at W=0 is 800 − 500 = 300; need 400; shortfall 100.
  ok(start - buffer === 300 && overdueAmt - 300 === 100,
    'independent leftover cannot cover the overdue amount');
  ok(rec.infeasible && rec.infeasible.id === 'overdue-item'
    && rec.infeasible.date === yesterday && near(rec.infeasible.shortfall, 100),
    'the failing constraint keeps the original scheduled date and the $100 shortfall',
    rec.infeasible && JSON.stringify(rec.infeasible));
  const row = (rec.majorPlans || []).find(p => p.id === 'overdue-item');
  ok(row && row.verdict === 'FUNDING GAP' && row.date === yesterday && row.scheduledDate === yesterday,
    'majorPlans still reports the overdue item on its original date',
    row && `${row.verdict} ${row.date}`);
  const events = F.expandEvents(plan, AS_OF, F.addDays(AS_OF, 30), {});
  ok(!events.some(e => e.id === 'overdue-item'),
    'expandEvents does not invent a new due date for the overdue item');

  const settledPlan = JSON.parse(JSON.stringify(plan));
  settledPlan.commitments[0].settledOn = AS_OF;
  const settled = F.recommend(settledPlan, AS_OF, recOpts());
  ok(!(settled.fundingSequence || []).some(x => x.id === 'overdue-item'),
    'settlement drops the overdue item from the sequence');
  ok(settled.mode === 'normal' && settled.holds === true,
    'after settledOn the overdue pressure disappears',
    `${settled.mode} holds=${settled.holds}`);
  const empty = F.recommend(barePlan({
    windowDays: 14, startingCash: { amount: start }, defaults: { targetBuffer: buffer },
  }), AS_OF, recOpts());
  ok(settled.weekly === empty.weekly,
    'settled overdue matches the empty-plan cap',
    `$${settled.weekly} vs $${empty.weekly}`);
}

{
  const yesterday = F.addDays(AS_OF, -1);
  const start = 2000;
  const buffer = 500;
  const overdueAmt = 400;
  const plan = barePlan({
    windowDays: 14,
    startingCash: { amount: start },
    defaults: { targetBuffer: buffer },
    commitments: [
      { id: 'overdue-item', label: 'Unpaid yesterday', date: yesterday,
        amount: overdueAmt, confidence: 'confirmed' },
    ],
  });
  const rec = F.recommend(plan, AS_OF, recOpts());
  const raw = (start - buffer - overdueAmt) * 7 / rec.knowledge.days;
  const want = Math.floor(raw / 5) * 5;
  ok(rec.mode === 'normal' && rec.weekly === want,
    'when cash can cover the overdue obligation it still reserves it in today\'s cap',
    `$${rec.weekly} vs hand $${want} (raw ${raw.toFixed(4)})`);
  ok(rec.knowledge.encumbered === overdueAmt,
    'overdue point principal is encumbered until settlement',
    String(rec.knowledge.encumbered));
  const row = (rec.majorPlans || []).find(p => p.id === 'overdue-item');
  ok(row && row.verdict === 'ON TRACK' && row.date === yesterday,
    'majorPlans agrees the overdue item is reserved on its original date, not vanished',
    row && `${row.verdict} ${row.date}`);
}

{
  // Later ordinary income must not retroactively fund a past deadline.
  // Independent: as-of surplus is 600 − 500 = 100; overdue floor 1000;
  // current gap 900. Horizon leftover includes +$5,000 on 2026-08-30.
  const due = '2026-08-15';
  const laterIncome = '2026-08-30';
  const start = 600;
  const buffer = 500;
  const overdueAmt = 1000;
  const plan = barePlan({
    windowDays: 40,
    startingCash: { amount: start },
    defaults: { targetBuffer: buffer },
    income: [{
      id: 'after-deadline', label: 'Pay after overdue date', frequency: 'once',
      date: laterIncome, amount: 5000, confidence: 'confirmed',
    }],
    commitments: [
      { id: 'overdue-item', label: 'Unpaid yesterday', date: due,
        amount: overdueAmt, confidence: 'confirmed' },
    ],
  });
  ok(AS_OF === '2026-08-16' && start - buffer === 100 && overdueAmt - 100 === 900,
    'independent: as-of cash above the buffer is $100; the overdue floor is short $900');
  ok(start + 5000 - buffer >= overdueAmt,
    'independent: end-horizon leftover after later income would cover the $1,000');
  const rec = F.recommend(plan, AS_OF, recOpts());
  ok(rec.mode === 'infeasible' && rec.holds === false && rec.weekly === 0,
    'later income cannot make an overdue point obligation look feasible',
    `${rec.mode} weekly=${rec.weekly} holds=${rec.holds}`);
  ok(rec.infeasible && rec.infeasible.kind === 'overdue'
    && rec.infeasible.id === 'overdue-item' && rec.infeasible.date === due
    && near(rec.infeasible.shortfall, 900),
    'INFEASIBLE names the original scheduled date and the $900 current shortfall',
    rec.infeasible && JSON.stringify(rec.infeasible));
  const row = (rec.majorPlans || []).find(p => p.id === 'overdue-item');
  ok(row && row.verdict === 'FUNDING GAP' && row.date === due && row.scheduledDate === due
    && near(row.remaining, 900) && near(row.margin, -900),
    'majorPlans is FUNDING GAP on the original date; remaining is the $900 as-of gap',
    row && `${row.verdict} remaining=${row.remaining} margin=${row.margin}`);
  const events = F.expandEvents(plan, AS_OF, F.addDays(AS_OF, 30), {});
  ok(!events.some(e => e.id === 'overdue-item'),
    'expandEvents still does not invent a new due date for the overdue item');

  // Independent: $50 as-of draw lifts surplus to $150, still $850 short.
  const under = F.plannedDebt(plan, AS_OF, recOpts({
    allowPlannedDebt: true,
    plannedDebtFacility: 'card-x',
    plannedDebtPurposes: ['overdue-item'],
    debts: [{ id: 'card-x', label: 'A card', rate: 19.99, balance: 0, pending: 0, limit: 50 }],
    plannedDebtPayment: 10,
    weeklyVariable: 0,
  }));
  ok(near(under.borrowed, 50),
    'an under-capacity overdue draw still borrows the $50 as-of room',
    String(under.borrowed));
  ok(start + 50 - buffer === 150 && 1000 - 150 === 850,
    'independent: $50 on as-of still leaves a $850 current overdue gap');
  ok(under.feasible === false,
    'later income still cannot make an under-financed overdue obligation feasible',
    `feasible=${under.feasible} borrowed=${under.borrowed}`);

  const covers = F.plannedDebt(plan, AS_OF, recOpts({
    allowPlannedDebt: true,
    plannedDebtFacility: 'card-x',
    plannedDebtPurposes: ['overdue-item'],
    debts: [{ id: 'card-x', label: 'A card', rate: 19.99, balance: 0, pending: 0, limit: 5000 }],
    plannedDebtPayment: 50,
    weeklyVariable: 0,
  }));
  ok(near(covers.borrowed, 900) && covers.draws && covers.draws[0] && covers.draws[0].date === AS_OF,
    'the overdue gap is drawn on as-of, not on a rewritten due date',
    covers.draws && JSON.stringify(covers.draws));
  ok(start + 900 - buffer === overdueAmt,
    'independent: a $900 as-of draw lands current surplus on the $1,000 overdue floor');
  ok(covers.feasible === true,
    'authorized planned debt may close the overdue as-of gap on the same walk',
    `feasible=${covers.feasible} borrowed=${covers.borrowed}`);
}

{
  // Two overdue floors share one as-of pool. $80 + $80 against $100 surplus
  // is a $60 joint gap; checking each item alone would wrongly pass.
  const firstDue = F.addDays(AS_OF, -2);
  const secondDue = F.addDays(AS_OF, -1);
  const start = 600;
  const buffer = 500;
  const each = 80;
  const plan = barePlan({
    windowDays: 40,
    startingCash: { amount: start },
    defaults: { targetBuffer: buffer },
    income: [{
      id: 'after-deadline', label: 'Pay after overdue dates', frequency: 'once',
      date: F.addDays(AS_OF, 14), amount: 5000, confidence: 'confirmed',
    }],
    commitments: [
      { id: 'overdue-a', label: 'Unpaid two days ago', date: firstDue,
        amount: each, confidence: 'confirmed' },
      { id: 'overdue-b', label: 'Unpaid yesterday', date: secondDue,
        amount: each, confidence: 'confirmed' },
    ],
  });
  ok(start - buffer === 100 && each + each - 100 === 60,
    'independent: $100 as-of surplus cannot cover two $80 overdue floors');
  const rec = F.recommend(plan, AS_OF, recOpts());
  ok(rec.mode === 'infeasible' && rec.holds === false && rec.weekly === 0,
    'aggregated overdue floors are INFEASIBLE even though each item is under $100',
    `${rec.mode} weekly=${rec.weekly}`);
  ok(rec.infeasible && rec.infeasible.kind === 'overdue'
    && rec.infeasible.date === firstDue && near(rec.infeasible.shortfall, 60)
    && Array.isArray(rec.infeasible.ids)
    && rec.infeasible.ids.includes('overdue-a') && rec.infeasible.ids.includes('overdue-b'),
    'the failing constraint keeps original dates and names both overdue items',
    rec.infeasible && JSON.stringify(rec.infeasible));
  const plans = rec.majorPlans || [];
  const a = plans.find(p => p.id === 'overdue-a');
  const b = plans.find(p => p.id === 'overdue-b');
  ok(a && a.verdict === 'FUNDING GAP' && a.date === firstDue && a.scheduledDate === firstDue
    && near(a.remaining, 60),
    'first overdue item is FUNDING GAP on its original date with the joint $60 gap',
    a && `${a.verdict} ${a.date} remaining=${a.remaining}`);
  ok(b && b.verdict === 'FUNDING GAP' && b.date === secondDue && b.scheduledDate === secondDue
    && near(b.remaining, 60),
    'second overdue item is FUNDING GAP on its original date; the same $100 cannot fund both',
    b && `${b.verdict} ${b.date} remaining=${b.remaining}`);

  const debt = F.plannedDebt(plan, AS_OF, recOpts({
    allowPlannedDebt: true,
    plannedDebtFacility: 'card-x',
    plannedDebtPurposes: ['overdue-a', 'overdue-b'],
    debts: [{ id: 'card-x', label: 'A card', rate: 19.99, balance: 0, pending: 0, limit: 5000 }],
    plannedDebtPayment: 20,
    weeklyVariable: 0,
  }));
  ok(near(debt.borrowed, 60),
    'two named overdue purposes borrow the $60 joint gap once, not $120',
    String(debt.borrowed));
  ok(start + 60 - buffer === each + each,
    'independent: a $60 as-of draw lands current surplus on the $160 overdue floor');
  ok(debt.feasible === true,
    'the $60 same-walk draw plus repayment leaves the protected plan feasible',
    `feasible=${debt.feasible} borrowed=${debt.borrowed} draws=${debt.draws && debt.draws.length}`);
}

{
  // Optional overdue residual is not the protected joint overdue pool.
  // Two named optional purposes with independent $100 gaps must both be
  // financed when the owner names both; they must not share one $100.
  const firstDue = F.addDays(AS_OF, -2);
  const secondDue = F.addDays(AS_OF, -1);
  const start = 500;
  const buffer = 500;
  const each = 100;
  const plan = barePlan({
    windowDays: 40,
    startingCash: { amount: start },
    defaults: { targetBuffer: buffer },
    commitments: [
      { id: 'opt-a', label: 'Optional overdue A', date: firstDue,
        amount: each, optional: true, confidence: 'estimated' },
      { id: 'opt-b', label: 'Optional overdue B', date: secondDue,
        amount: each, optional: true, confidence: 'estimated' },
    ],
  });
  ok(start - buffer === 0 && each + each === 200,
    'independent: no leftover residual; two optional $100 gaps sum to $200');
  const plans = F.majorPlans(plan, AS_OF, recOpts({ weeklyVariable: 0 }));
  const optA = plans.find(p => p.id === 'opt-a');
  const optB = plans.find(p => p.id === 'opt-b');
  ok(optA && optA.flexibility === 'optional' && optA.verdict === 'FUNDING GAP'
    && near(optA.remaining, each),
    'first optional overdue keeps an independent $100 residual gap',
    optA && `${optA.verdict} remaining=${optA.remaining}`);
  ok(optB && optB.flexibility === 'optional' && optB.verdict === 'FUNDING GAP'
    && near(optB.remaining, each),
    'second optional overdue keeps an independent $100 residual gap',
    optB && `${optB.verdict} remaining=${optB.remaining}`);
  const debt = F.plannedDebt(plan, AS_OF, recOpts({
    allowPlannedDebt: true,
    plannedDebtFacility: 'card-x',
    plannedDebtPurposes: ['opt-a', 'opt-b'],
    debts: [{ id: 'card-x', label: 'A card', rate: 19.99, balance: 0, pending: 0, limit: 5000 }],
    plannedDebtPayment: 20,
    weeklyVariable: 0,
  }));
  ok(near(debt.borrowed, 200),
    'two past-dated optional named purposes borrow $200, not a shared $100',
    String(debt.borrowed));
}

{
  // Explicit $20 on protected overdue A counts toward the $60 joint
  // shortfall before B is auto-sized. Total borrowed is $60, not $80.
  const firstDue = F.addDays(AS_OF, -2);
  const secondDue = F.addDays(AS_OF, -1);
  const start = 600;
  const buffer = 500;
  const each = 80;
  const plan = barePlan({
    windowDays: 40,
    startingCash: { amount: start },
    defaults: { targetBuffer: buffer },
    income: [{
      id: 'after-deadline', label: 'Pay after overdue dates', frequency: 'once',
      date: F.addDays(AS_OF, 14), amount: 5000, confidence: 'confirmed',
    }],
    commitments: [
      { id: 'overdue-a', label: 'Unpaid two days ago', date: firstDue,
        amount: each, confidence: 'confirmed' },
      { id: 'overdue-b', label: 'Unpaid yesterday', date: secondDue,
        amount: each, confidence: 'confirmed' },
    ],
  });
  ok(start - buffer === 100 && each + each - 100 === 60,
    'independent: protected overdue aggregate is still $60 short before financing');
  const debt = F.plannedDebt(plan, AS_OF, recOpts({
    allowPlannedDebt: true,
    plannedDebtFacility: 'card-x',
    plannedDebtPurposes: ['overdue-a', 'overdue-b'],
    plannedDebtAmounts: { 'overdue-a': 20 },
    debts: [{ id: 'card-x', label: 'A card', rate: 19.99, balance: 0, pending: 0, limit: 5000 }],
    plannedDebtPayment: 20,
    weeklyVariable: 0,
  }));
  ok(near(debt.borrowed, 60),
    'explicit $20 on A plus auto B borrows $60 total, not $80',
    String(debt.borrowed));
  const drawnA = (debt.draws || []).find(d => d.id === 'overdue-a');
  const drawnB = (debt.draws || []).find(d => d.id === 'overdue-b');
  ok(drawnA && near(drawnA.amount, 20),
    'the explicit $20 on A still occurs',
    drawnA && String(drawnA.amount));
  ok(drawnB && near(drawnB.amount, 40),
    'B auto-sizes to the remaining $40 of the protected overdue pool',
    drawnB && String(drawnB.amount));
  ok(start + 60 - buffer === each + each,
    'independent: $60 as-of proceeds land current surplus on the $160 floor');
  ok(debt.feasible === true,
    'the $60 same-walk path leaves the protected plan feasible',
    `feasible=${debt.feasible} borrowed=${debt.borrowed}`);
}

{
  // Naming only A must not auto-draw the joint overdue gap that includes B.
  // Independent: surplus 0; A $50 + B $100 = $150 joint gap.
  const firstDue = F.addDays(AS_OF, -2);
  const secondDue = F.addDays(AS_OF, -1);
  const start = 500;
  const buffer = 500;
  const aAmt = 50;
  const bAmt = 100;
  const plan = barePlan({
    windowDays: 40,
    startingCash: { amount: start },
    defaults: { targetBuffer: buffer },
    income: [{
      id: 'after-deadline', label: 'Pay after overdue dates', frequency: 'once',
      date: F.addDays(AS_OF, 14), amount: 5000, confidence: 'confirmed',
    }],
    commitments: [
      { id: 'overdue-a', label: 'Unpaid A', date: firstDue,
        amount: aAmt, confidence: 'confirmed' },
      { id: 'overdue-b', label: 'Unpaid B', date: secondDue,
        amount: bAmt, confidence: 'confirmed' },
    ],
  });
  ok(start - buffer === 0 && aAmt + bAmt === 150,
    'independent: no as-of surplus; protected overdue floors sum to $150');
  const onlyA = F.plannedDebt(plan, AS_OF, recOpts({
    allowPlannedDebt: true,
    plannedDebtFacility: 'card-x',
    plannedDebtPurposes: ['overdue-a'],
    debts: [{ id: 'card-x', label: 'A card', rate: 19.99, balance: 0, pending: 0, limit: 5000 }],
    plannedDebtPayment: 20,
    weeklyVariable: 0,
  }));
  ok(near(onlyA.borrowed, aAmt),
    'naming only A auto-borrows at most A\'s $50 floor, not the $150 joint gap',
    String(onlyA.borrowed));
  const drawnOnlyA = (onlyA.draws || []).find(d => d.id === 'overdue-a');
  const drawnBFromA = (onlyA.draws || []).find(d => d.id === 'overdue-b');
  ok(drawnOnlyA && near(drawnOnlyA.amount, aAmt) && !drawnBFromA,
    'the $50 draw is labelled for A; unnamed B is not allocated',
    JSON.stringify(onlyA.draws));
  ok(onlyA.feasible === false,
    'the plan stays infeasible because unnamed B is still unfinanced',
    `feasible=${onlyA.feasible} borrowed=${onlyA.borrowed}`);

  const both = F.plannedDebt(plan, AS_OF, recOpts({
    allowPlannedDebt: true,
    plannedDebtFacility: 'card-x',
    plannedDebtPurposes: ['overdue-a', 'overdue-b'],
    debts: [{ id: 'card-x', label: 'A card', rate: 19.99, balance: 0, pending: 0, limit: 5000 }],
    plannedDebtPayment: 20,
    weeklyVariable: 0,
  }));
  ok(near(both.borrowed, aAmt + bAmt),
    'naming A and B may borrow the $150 joint gap',
    String(both.borrowed));
  const drawnA = (both.draws || []).find(d => d.id === 'overdue-a');
  const drawnB = (both.draws || []).find(d => d.id === 'overdue-b');
  ok(drawnA && near(drawnA.amount, aAmt) && drawnB && near(drawnB.amount, bAmt),
    'each named purpose auto-draws only its own base floor',
    JSON.stringify(both.draws));
  ok(start + aAmt + bAmt - buffer === aAmt + bAmt,
    'independent: a $150 as-of draw lands current surplus on the $150 floor');
  ok(both.feasible === true,
    'both named purposes plus repayment can make the protected plan feasible',
    `feasible=${both.feasible} borrowed=${both.borrowed}`);
}

{
  // Passing a ranged deadline is the overdue-point repair: original date,
  // min/max preserved, aggregate floor vs as-of surplus. surplusOn() has
  // no day before as-of, so testing item.date would be a permanent gap.
  const due = '2026-08-15';
  const laterIncome = '2026-08-30';
  const start = 2000;
  const buffer = 500;
  const floor = 1000;
  const ceiling = 1800;
  const plan = barePlan({
    windowDays: 40,
    startingCash: { amount: start },
    defaults: { targetBuffer: buffer },
    income: [{
      id: 'after-deadline', label: 'Pay after overdue range date', frequency: 'once',
      date: laterIncome, amount: 5000, confidence: 'confirmed',
    }],
    commitments: [{
      id: 'overdue-range', label: 'Unpaid ranged cost', date: due,
      amount: null, amountMin: floor, amountMax: ceiling, confidence: 'estimated',
    }],
  });
  ok(AS_OF === '2026-08-16' && start - buffer === 1500 && 1500 >= floor && 1500 < ceiling,
    'independent: as-of surplus covers the overdue range floor, not the ceiling');
  const rec = F.recommend(plan, AS_OF, recOpts());
  ok(rec.mode === 'normal' && rec.holds === true && rec.weekly >= 0,
    'enough as-of cash does not make an overdue range a FUNDING GAP',
    `${rec.mode} weekly=${rec.weekly} holds=${rec.holds}`);
  ok(rec.knowledge.encumbered === floor,
    'the overdue range floor stays encumbered until settlement',
    String(rec.knowledge.encumbered));
  const published = (rec.majorPlans || []).find(p => p.id === 'overdue-range');
  ok(published && published.verdict !== 'FUNDING GAP' && published.date === due
    && published.scheduledDate === due && published.need == null
    && published.amountMin === floor && published.amountMax === ceiling
    && published.encumbered === floor,
    'original date kept, range not collapsed, floor encumbered',
    published && `${published.verdict} ${published.date} min=${published.amountMin} max=${published.amountMax} encumbered=${published.encumbered}`);
  const asOfSurplus = start - buffer;
  const row = F.majorPlans(plan, AS_OF, recOpts({ weeklyVariable: 0 }))
    .find(p => p.id === 'overdue-range');
  ok(row && row.verdict === 'AT RISK' && near(row.remaining, ceiling - asOfSurplus)
    && near(row.margin, asOfSurplus - floor),
    'at zero weekly, AT RISK remaining is the independent $300 ceiling shortfall',
    row && `${row.verdict} remaining=${row.remaining} margin=${row.margin}`);
  const events = F.expandEvents(plan, AS_OF, F.addDays(AS_OF, 30), {});
  ok(!events.some(e => e.id === 'overdue-range'),
    'expandEvents does not invent a cash event or a new due date for the overdue range');
}

{
  // Later ordinary income must not retroactively fund a past ranged deadline.
  const due = '2026-08-15';
  const laterIncome = '2026-08-30';
  const start = 600;
  const buffer = 500;
  const floor = 1000;
  const ceiling = 1200;
  const plan = barePlan({
    windowDays: 40,
    startingCash: { amount: start },
    defaults: { targetBuffer: buffer },
    income: [{
      id: 'after-deadline', label: 'Pay after overdue range date', frequency: 'once',
      date: laterIncome, amount: 5000, confidence: 'confirmed',
    }],
    commitments: [{
      id: 'overdue-range', label: 'Unpaid ranged cost', date: due,
      amount: null, amountMin: floor, amountMax: ceiling, confidence: 'estimated',
    }],
  });
  ok(AS_OF === '2026-08-16' && start - buffer === 100 && floor - 100 === 900,
    'independent: as-of cash above the buffer is $100; the overdue range floor is short $900');
  ok(start + 5000 - buffer >= floor,
    'independent: end-horizon leftover after later income would cover the $1,000 floor');
  const rec = F.recommend(plan, AS_OF, recOpts());
  ok(rec.mode === 'infeasible' && rec.holds === false && rec.weekly === 0,
    'later income cannot make an overdue range look feasible',
    `${rec.mode} weekly=${rec.weekly} holds=${rec.holds}`);
  ok(rec.infeasible && rec.infeasible.kind === 'overdue'
    && rec.infeasible.id === 'overdue-range' && rec.infeasible.date === due
    && near(rec.infeasible.shortfall, 900),
    'INFEASIBLE names the original scheduled date and the $900 current range-floor shortfall',
    rec.infeasible && JSON.stringify(rec.infeasible));
  const row = (rec.majorPlans || []).find(p => p.id === 'overdue-range');
  ok(row && row.verdict === 'FUNDING GAP' && row.date === due
    && row.amountMin === floor && row.amountMax === ceiling
    && near(row.remaining, 900) && row.encumbered === floor,
    'majorPlans keeps the overdue range as a range on the original date',
    row && `${row.verdict} remaining=${row.remaining} min=${row.amountMin} max=${row.amountMax}`);
}

console.log('\n=== existing consumers still derive from Forecast ===');
{
  const planJs = read('public/plan.js');
  ok(/advice\.majorPlans|Forecast\.majorPlans/.test(planJs),
    'the Plan page renders Forecast.majorPlans and does not invent the verdicts');
  ok(!/verdict\s*=\s*['"]ON TRACK['"]/.test(planJs),
    'the Plan page does not assign ON TRACK itself');
  ok(/Forecast\.recommend\(/.test(planJs),
    'the Plan page still takes the weekly cap from Forecast.recommend');
}

console.log('\n=== live opening: Q19, buffer, cards, undated rows ===');
{
  const live = require('../data.json');
  const asOf = live.meta.asOf;
  ok(asOf === live.meta.asOf, 'this live walk uses the current canonical as-of', asOf);
  const advice = F.recommend(live.plan, asOf, recOpts({
    fundingSources: live.plan.funding && live.plan.funding.options,
  }));
  ok(advice.knowledge.days >= 365, 'live recommend searched at least 12 months',
    String(advice.knowledge.days));
  ok(advice.sim.weeks.length === 13, 'the returned view is still the 13-week display',
    String(advice.sim.weeks.length));
  ok(advice.plannedDebt.borrowed === 0 && advice.plannedDebt.permitted === false,
    'live recommend does not invent planned debt');
  ok(advice.mode === 'normal' && advice.holds === true && advice.infeasible == null,
    'live opening remains a feasible normal recommendation',
    `${advice.mode} holds=${advice.holds}`);
  ok(advice.buffer === 500, 'the $500 model buffer is unchanged', String(advice.buffer));
  ok(advice.knowledge.encumbered === 0,
    'owner-dated live commitments leave no undated protected principal on the master walk',
    String(advice.knowledge.encumbered));
  ok(near(advice.knowledge.freeCash,
    advice.knowledge.ending - advice.buffer - advice.knowledge.encumbered),
    'live free cash is ending − buffer − encumbered, not leftover after buffer alone');
  ok(!(live.plan.commitments || []).some(c => c.id === 'indio-tournament'),
    'Indio is not an active live commitment');
  const sanDiego = (live.plan.commitments || []).find(c => c.id === 'san-diego');
  ok(sanDiego && F.commitmentNeed(sanDiego) === 3000 && sanDiego.amountMin == null
      && sanDiego.date === '2027-01-15' && sanDiego.tripWindow === 'Jan 9–10, 2027',
    'San Diego is a $3,000 point on the clear-month cash date, with the trip window separate');
  const linden = (live.plan.commitments || []).find(c => c.id === 'linden-birthday');
  const seattleDec = (live.plan.commitments || []).find(c => c.id === 'seattle-dec');
  ok(linden && F.commitmentNeed(linden) === 500 && linden.date === '2026-12-09'
      && linden.label === 'Linden birthday' && linden.tripWindow == null
      && !Object.prototype.hasOwnProperty.call(linden, 'payingAccount'),
    'Linden birthday is a $500 point on 2026-12-09 with no payingAccount or tripWindow');
  ok((live.plan.commitments || []).filter(c => c.id === 'linden-birthday').length === 1,
    'exactly one live linden-birthday commitment');
  ok(seattleDec && seattleDec.date === '2026-12-09' && F.commitmentNeed(seattleDec) === 1500,
    'seattle-dec remains $1,500 on 2026-12-09 beside Linden');
  const decEvents = F.expandEvents(live.plan, asOf, '2026-12-31', {});
  const lindenCash = decEvents.filter(e => e.id === 'linden-birthday');
  ok(lindenCash.length === 1 && lindenCash[0].date === '2026-12-09' && near(lindenCash[0].amount, -500),
    'Forecast emits Linden birthday once at −500 on 2026-12-09');
  ok(decEvents.filter(e => e.id === 'seattle-dec').length === 1,
    'seattle-dec still emits once through 31 Dec beside Linden');
  ok(!/emergency reserve/i.test(read('public/forecast.js')),
    'the engine does not relabel the $500 buffer as an emergency reserve');

  const windowEnd = F.addDays(asOf, (live.plan.windowDays || 91) - 1);
  const undatedIds = (live.plan.commitments || [])
    .filter(c => !c.date)
    .map(c => c.id);
  const events = F.expandEvents(live.plan, asOf, windowEnd, {});
  ok(!events.some(e => undatedIds.includes(e.id)),
    'undated live commitments still emit no cash event in the 91-day view');

  const heloc = (live.plan.funding && live.plan.funding.options || [])
    .find(o => o.id === 'heloc');
  ok(heloc && /Q19/.test(heloc.note || '') && /ANSWERED/i.test(heloc.note || ''),
    'live HELOC funding option records Q19 ANSWERED');
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll master-forecast checks passed.');
