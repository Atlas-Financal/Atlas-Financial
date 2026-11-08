'use strict';
/* Payday snapshot vs live Current Balance (L-002 / L-006).
 *
 * Independent reconstruction:
 *   Dale + Amanda + recognized Other Income = Payday balance
 *   prior period cash leftover (opening + incomeAdded − bills − hold,
 *   payday-boundary known) = next period opening
 * Live Current Balance is posted hub chequing-a and must not mutate the
 * snapshot. Opening cash is not a term in the allocation waterfall.
 * Active household waterfall hides Q01 Opening.
 *
 * `node test/test-payday-snapshot-live-balance.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;
const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

function grab(src, re, label) {
  const match = re.exec(src);
  if (!match) throw new Error('missing ' + label);
  return match[0];
}

function loadComposer() {
  const appSrc = read('public/app.js');
  const planSrc = read('public/plan.js');
  const source = [
    grab(appSrc, /^const money = .*$/m, 'money'),
    grab(appSrc, /^const money2 = .*$/m, 'money2'),
    grab(appSrc, /^const escapeHtml = .*$/m, 'escapeHtml'),
    grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
    grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
    grab(planSrc, /^function liveOperatingPlanUnavailable\([\s\S]*?\n\}$/m, 'liveOperatingPlanUnavailable'),
    grab(planSrc, /^function liveOperatingPlanNote\([\s\S]*?\n\}$/m, 'liveOperatingPlanNote'),
    grab(planSrc, /^function paydayGlanceCashNote\([\s\S]*?\n\}$/m, 'paydayGlanceCashNote'),
    grab(planSrc, /^function providerBalanceDate\([\s\S]*?\n\}$/m, 'providerBalanceDate'),
    grab(planSrc, /^function glanceUpdatedNote\([\s\S]*?\n\}$/m, 'glanceUpdatedNote'),
    grab(planSrc, /^function glanceSignedMoney\([\s\S]*?\n\}$/m, 'glanceSignedMoney'),
    grab(planSrc, /^function glanceMoney\([\s\S]*?\n\}$/m, 'glanceMoney'),
    grab(planSrc, /^function glanceLineLabel\([\s\S]*?\n\}$/m, 'glanceLineLabel'),
    grab(planSrc, /^function cashGlanceHtml\([\s\S]*?\n\}$/m, 'cashGlanceHtml'),
    grab(planSrc, /^function liveCurrentBalanceHtml\([\s\S]*?\n\}$/m, 'liveCurrentBalanceHtml'),
    grab(planSrc, /^function runningLeftoverHtml\([\s\S]*?\n\}$/m, 'runningLeftoverHtml'),
    grab(planSrc, /^function periodBillLine\([\s\S]*?\n\}$/m, 'periodBillLine'),
    grab(planSrc, /^function calendarCurrentUnavailableHtml\([\s\S]*?\n\}$/m, 'calendarCurrentUnavailableHtml'),
    grab(planSrc, /^function calendarIncomeHtml\([\s\S]*?\n\}$/m, 'calendarIncomeHtml'),
    grab(planSrc, /^function householdBudgetCycleText\([\s\S]*?\n\}$/m, 'householdBudgetCycleText'),
    grab(planSrc, /^function householdBudgetMetric\([\s\S]*?\n\}$/m, 'householdBudgetMetric'),
    grab(planSrc, /^function householdBudgetCategoryHtml\([\s\S]*?\n\}$/m, 'householdBudgetCategoryHtml'),
    grab(planSrc, /^function calendarBudgetHtml\([\s\S]*?\n\}$/m, 'calendarBudgetHtml'),
    grab(planSrc, /^function calendarPeriodBillsHtml\([\s\S]*?\n\}$/m, 'calendarPeriodBillsHtml'),
    grab(planSrc, /^function extraRepaymentHtml\([\s\S]*?\n\}$/m, 'extraRepaymentHtml'),
    grab(planSrc, /^function calendarFromTodayEvidenceHtml\([\s\S]*?\n\}$/m, 'calendarFromTodayEvidenceHtml'),
    grab(planSrc, /^function calendarWaterfallHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallHtml'),
    grab(planSrc, /^function calendarPickerHtml\([\s\S]*?\n\}$/m, 'calendarPickerHtml'),
    grab(planSrc, /^function calendarWaterfallsHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallsHtml'),
  ].join('\n');
  return vm.runInNewContext(
    `${source}\n({ calendarWaterfallHtml, calendarWaterfallsHtml, liveCurrentBalanceHtml, providerBalanceDate, money2 });`,
    { Forecast: F }
  );
}

const PAYDAY = '2026-08-28';
const MID = '2026-09-04';
const OPENING = 1000;
const DALE = 4000;
const AMANDA = 2000;
const PERIOD_INCOME = roundCent(DALE + AMANDA);
const AFTER_PAYDAY = PERIOD_INCOME;
const LIVE_LATER = 2300;
const PERIOD1_BILL = 5600;
const PERIOD2_INCOME = 6000;
const PERIOD1_BAD = roundCent(PERIOD2_INCOME - PERIOD1_BILL);
const PERIOD1_CASH_LEFTOVER = roundCent(OPENING + PERIOD2_INCOME - PERIOD1_BILL);
const PERIOD2_AFTER = PERIOD2_INCOME;
const BUFFER = 500;

const debts = [
  {
    id: 'cashback', label: 'Synthetic card', secured: false,
    structure: 'Revolving — test', balance: 800, rate: 19.99, payment: 20, pending: 0,
  },
];

function hubCash(amount) {
  return {
    amount,
    breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: amount }],
  };
}

function basePlan(overrides) {
  return Object.assign({
    defaults: { targetBuffer: BUFFER },
    startingCash: hubCash(OPENING),
    nextDollar: {
      policy: 'true-surplus-highest-interest',
      provenance: 'owner-stated',
    },
    opening: { asOf: PAYDAY, representedEvents: [] },
    income: [
      {
        id: 'payroll', label: 'Dale', frequency: 'biweekly',
        anchor: PAYDAY, amount: DALE, confidence: 'confirmed',
      },
      {
        id: 'amandaPayday', label: 'Amanda', frequency: 'once',
        date: PAYDAY, amount: AMANDA, confidence: 'confirmed',
      },
    ],
    bills: [],
    obligations: [],
    commitments: [],
    budget: { categories: [] },
  }, overrides || {});
}

function period(view, id) {
  return ((view && view.calendarPeriods) || []).find(p => p.id === id);
}

function incomeRow(p, id) {
  return ((p && p.income) || []).find(r => r && r.id === id) || null;
}

function recommend(plan, asOf, extra) {
  return F.recommend(plan, asOf, Object.assign({
    targetBuffer: plan.defaults.targetBuffer,
    debts,
  }, extra || {}));
}

const composer = loadComposer();
const planSrc = read('public/plan.js');

console.log('=== 1. Live balance changes mid-period do not mutate the snapshot ===');
{
  const paydayPlan = basePlan();
  const paydayAdvice = recommend(paydayPlan, PAYDAY);
  const paydayActive = period(paydayAdvice.defaultView, 'this-pay-period');
  const independentAfter = PERIOD_INCOME;
  ok(paydayActive && paydayActive.start === PAYDAY,
    'This Pay Period starts on the synthetic payday');
  const publication = paydayAdvice.paydayAllocation.currentBalancePublication;
  ok(paydayAdvice.defaultView.liveCurrentBalance == null
      && paydayAdvice.paydayAllocation.liveCurrentBalance == null
      && publication && publication.status === 'unavailable'
      && !near(paydayAdvice.paydayAllocation.liveCurrentBalance, roundCent(OPENING + DALE)),
    'same-day opening is not a proven pre-payday base, so Current Balance does not add Dale payroll');
  ok(near(paydayActive.opening, OPENING) && paydayActive.openingKnown === true,
    'payday-morning snapshot opening is posted cash');
  ok(near(paydayActive.incomeAdded, PERIOD_INCOME)
      && near(paydayActive.available, independentAfter)
      && near(paydayActive.available, paydayActive.incomeTotal),
    'independent Dale + Amanda equals Payday balance');

  const laterPlan = basePlan({
    startingCash: hubCash(LIVE_LATER),
    opening: {
      asOf: MID,
      priorAsOf: PAYDAY,
      paydaySnapshot: { periodStart: PAYDAY, asOf: PAYDAY, opening: OPENING },
      representedEvents: [],
    },
  });
  const laterAdvice = recommend(laterPlan, MID);
  const laterActive = period(laterAdvice.defaultView, 'this-pay-period');
  ok(near(laterAdvice.defaultView.liveCurrentBalance, LIVE_LATER),
    'mid-period live Current Balance follows provider cash');
  ok(near(laterActive.opening, OPENING) && laterActive.openingKnown === true,
    'frozen payday opening stays $1,000 after live cash moves');
  ok(near(laterActive.available, independentAfter)
      && near(laterActive.available, paydayActive.available),
    'Payday balance stays Dale + Amanda when live cash becomes $2,300');
  ok(!near(laterActive.opening, LIVE_LATER)
      && !near(laterActive.available, LIVE_LATER)
      && !near(laterActive.available, roundCent(LIVE_LATER + PERIOD_INCOME)),
    'snapshot is not today\'s live cash and is not live cash plus income');
}

console.log('\n=== 2. Non-zero carry-forward becomes the next opening ===');
{
  const plan = basePlan({
    bills: [{
      id: 'period1-out', label: 'Period 1 outflow', frequency: 'once',
      date: '2026-08-29', amount: PERIOD1_BILL, confidence: 'confirmed',
    }],
    income: [
      {
        id: 'payroll', label: 'Dale', frequency: 'biweekly',
        anchor: PAYDAY, amount: PERIOD2_INCOME, confidence: 'confirmed',
      },
    ],
  });
  const advice = recommend(plan, PAYDAY, { targetBuffer: 0, debts: [] });
  const p1 = period(advice.defaultView, 'this-pay-period');
  const p2 = period(advice.defaultView, 'next-pay-period');
  const independentP1After = PERIOD2_INCOME;
  const independentP1CashLeftover = PERIOD1_CASH_LEFTOVER;
  const independentP1Bad = PERIOD1_BAD;
  const independentP2After = PERIOD2_INCOME;
  ok(p1 && p2 && p1.role === 'active' && p2.role === 'future',
    'Period 1 is active and Period 2 is future');
  ok(near(p1.opening, OPENING) && near(p1.available, independentP1After),
    'Period 1 Payday balance independently equals period income');
  ok(near(p1.budgetHold, 0) && near(p1.remainingBills, PERIOD1_BILL),
    'Period 1 has no household-budget hold and one known outflow');
  ok(near(p1.afterHouseholdBudget, independentP1Bad)
      && near(p1.projectedEnding, independentP1Bad)
      && near(p1.afterBigPurchases, independentP1Bad),
    'independent Period 1 projectedEnding follows BAD, not cash leftover');
  ok(p2.openingKnown && near(p2.opening, independentP1CashLeftover)
      && !near(p2.opening, p1.projectedEnding),
    'Period 2 opening independently equals Period 1 cash leftover, not BAD projectedEnding');
  ok(near(p2.available, independentP2After)
      && near(p2.available, p2.incomeTotal),
    'Period 2 Payday balance independently equals that period\'s income');
  ok(!near(p2.opening, 0) && !near(p2.opening, BUFFER)
      && !near(p2.opening, OPENING) && !near(p2.opening, PERIOD2_INCOME),
    'Period 2 does not reset to $0, $500, live opening cash, or income-only');
}

console.log('\n=== 3. First period uses the real opening; otherwise fail closed ===');
{
  const paydayAdvice = recommend(basePlan(), PAYDAY);
  const paydayActive = period(paydayAdvice.defaultView, 'this-pay-period');
  ok(paydayActive.openingSource === 'payday-morning'
      && near(paydayActive.opening, OPENING),
    'first payday uses posted cash, not an invented $500 opening');
  ok(!near(paydayActive.opening, BUFFER),
    'payday-morning opening is not the $500 buffer');

  const liveMid = basePlan({
    startingCash: hubCash(LIVE_LATER),
    opening: { asOf: MID, priorAsOf: PAYDAY, representedEvents: [] },
  });
  const closed = recommend(liveMid, MID);
  const closedActive = period(closed.defaultView, 'this-pay-period');
  ok(near(closed.defaultView.liveCurrentBalance, LIVE_LATER),
    'fail-closed mid-period still publishes live Current Balance');
  ok(closedActive.openingKnown !== true && closedActive.opening == null
      && closedActive.incomeAdded == null,
    'live mid-period without a payday snapshot fails closed on the opening');
  ok(near(closedActive.available, PERIOD_INCOME)
      && near(closedActive.available, closedActive.incomeTotal),
    'Payday balance still publishes the income identity when opening is withheld');
  ok((closedActive.income || []).some(r => r && r.id === 'payroll' && near(r.amount, DALE)),
    'fail-closed snapshot still lists the period income row');
}

console.log('\n=== 4. $500 buffer stays a safety floor and does not enter payday arithmetic ===');
{
  const plan = basePlan({
    bills: [{
      id: 'small-bill', label: 'Small bill', frequency: 'once',
      date: '2026-08-29', amount: 5400, confidence: 'confirmed',
    }],
  });
  const withBuf = recommend(plan, PAYDAY, { targetBuffer: BUFFER });
  const noBuf = recommend(plan, PAYDAY, { targetBuffer: 0 });
  const activeBuf = period(withBuf.defaultView, 'this-pay-period');
  const activeZero = period(noBuf.defaultView, 'this-pay-period');
  const independentAfter = PERIOD_INCOME;
  ok(near(activeBuf.opening, OPENING) && near(activeZero.opening, OPENING)
      && near(activeBuf.available, independentAfter)
      && near(activeZero.available, independentAfter)
      && !near(activeBuf.available, independentAfter - BUFFER),
    'payday opening and Payday balance do not subtract or substitute $500');
  const leftoverAfterBudget = roundCent(
    (Number(activeBuf.incomeTotal) || independentAfter) - 5400
    - (Number(activeBuf.budgetHold) || 0));
  const independentRoom = roundCent(Math.max(0, leftoverAfterBudget - BUFFER));
  const zeroRoom = roundCent(Math.max(0, leftoverAfterBudget));
  ok(near(activeBuf.afterHouseholdBudget, leftoverAfterBudget)
      && near(activeZero.afterHouseholdBudget, leftoverAfterBudget)
      && independentRoom === leftoverAfterBudget - BUFFER
      && activeBuf.extraDebt.allocated <= independentRoom
      && activeBuf.extraDebt.allocated < leftoverAfterBudget,
    'unrelated $500 safety floor still limits extra-debt room');
  ok(zeroRoom > independentRoom
      && activeZero.extraDebt.allocated <= zeroRoom
      && near(activeBuf.opening, activeZero.opening)
      && near(activeBuf.available, activeZero.available),
    'removing the buffer changes extra-debt room, not the payday snapshot');
}

console.log('\n=== 5. Received income is not double-counted against live cash ===');
{
  const laterPlan = basePlan({
    startingCash: hubCash(LIVE_LATER),
    opening: {
      asOf: MID,
      priorAsOf: '2026-08-19',
      paydaySnapshot: { periodStart: PAYDAY, asOf: PAYDAY, opening: OPENING },
      representedEvents: [
        { id: 'payroll', date: PAYDAY },
        { id: 'amandaPayday', date: PAYDAY },
      ],
    },
  });
  const advice = recommend(laterPlan, MID);
  const active = period(advice.defaultView, 'this-pay-period');
  const dale = incomeRow(active, 'payroll');
  const amanda = incomeRow(active, 'amandaPayday');
  ok(near(advice.defaultView.liveCurrentBalance, LIVE_LATER),
    'live Current Balance is the mid-period observation');
  ok(dale && near(dale.amount, DALE) && dale.alreadyInCash === true,
    'received Dale row stays visible as settlement evidence');
  ok(amanda && near(amanda.amount, AMANDA),
    'Amanda period income stays on the snapshot');
  ok(near(active.opening, OPENING) && !near(active.opening, LIVE_LATER),
    'frozen payday opening is not today\'s live balance');
  ok(near(active.incomeAdded, PERIOD_INCOME)
      && near(active.available, AFTER_PAYDAY),
    'Payday balance still equals the period income identity once');
  ok(!near(active.available, roundCent(LIVE_LATER + PERIOD_INCOME))
      && !near(active.available, roundCent(LIVE_LATER + AMANDA)),
    'the same paycheque is not added on top of live cash');
}

console.log('\n=== 6. Default Plan visually separates live cash from the payday snapshot ===');
{
  const advice = recommend(basePlan(), PAYDAY);
  const html = composer.calendarWaterfallsHtml(
    advice.defaultView, 'this-pay-period', {
      applied: true,
      operatingPlan: 'live',
      fetchedAt: '2026-09-04T18:00:00.000Z',
      observedAsOf: '2026-09-04',
      observedCash: {
        complete: true,
        asOf: '2026-09-04',
        accounts: [
          { id: 'chequing-a', value: OPENING, evidenceDate: '2026-09-04' },
        ],
      },
    }, advice.paydayAllocation);
  const pickerStart = html.indexOf('data-calendar-period-picker');
  const liveStart = html.indexOf('data-live-current-balance');
  const cardStart = html.indexOf('data-calendar-waterfall="this-pay-period"');
  const liveBlock = liveStart >= 0 ? html.slice(liveStart, cardStart) : '';
  const card = cardStart >= 0 ? html.slice(cardStart) : '';
  ok(liveStart >= 0 && pickerStart > liveStart && pickerStart < cardStart,
    'live Current Balance prints first, then selector, then payday snapshot');
  ok(liveStart >= 0 && cardStart > liveStart,
    'live Current Balance is rendered before the payday snapshot card');
  ok(/Current Balance/.test(liveBlock) && /as of September 4/.test(liveBlock)
      && !liveBlock.includes(composer.money2(roundCent(OPENING + DALE)))
      && !/awaiting bank update/.test(liveBlock),
    'live glance does not print same-day cash plus planned Dale payroll');
  ok(!/data-operating-prompt="Current Balance"/.test(card)
      && !/data-operating-prompt="Current balance as of/.test(card)
      && !/data-operating-prompt="Opening balance"/.test(card)
      && !/data-operating-question="01"/.test(card),
    'active payday card hides Q01 Opening; live Current Balance is the hub glance, not the card');
  ok(/data-operating-prompt="Income"/.test(card)
      && /Payday balance/.test(card)
      && !/data-operating-prompt="Balance after payday"/.test(card)
      && /data-operating-prompt="Bills"/.test(card)
      && /data-operating-prompt="Household budget"/.test(card),
    'payday card still prints income, Payday balance, bills, and budget');
  const cardIncomeLine = card.indexOf('data-period-income');
  const cardPayday = card.indexOf('data-payday-balance');
  ok(cardIncomeLine >= 0 && cardPayday > cardIncomeLine
      && cardPayday < card.indexOf('data-operating-prompt="Bills"'),
    'Payday balance remains under income lines inside the payday card');
  const next = period(advice.defaultView, 'next-pay-period');
  const nextHtml = composer.calendarWaterfallHtml(next, null, advice.paydayAllocation);
  ok(/data-operating-prompt="Opening balance"/.test(nextHtml)
      && !/Current Balance/.test(nextHtml),
    'future period shows carry-forward Opening balance, not live Current Balance');
  const waterfallFn = grab(planSrc, /^function calendarWaterfallHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallHtml');
  const liveFn = grab(planSrc, /^function liveCurrentBalanceHtml\([\s\S]*?\n\}$/m, 'liveCurrentBalanceHtml');
  const incomeFn = grab(planSrc, /^function calendarIncomeHtml\([\s\S]*?\n\}$/m, 'calendarIncomeHtml');
  ok(/period\.available/.test(incomeFn)
      && /Payday balance/i.test(incomeFn)
      && !/\.opening\s*\+/.test(incomeFn)
      && !/Assigned income/i.test(incomeFn),
    'plan.js renders Forecast available as Payday balance; it does not add opening + income');
  ok(/view\.liveCurrentBalance|alloc\.liveCurrentBalance/.test(liveFn)
      && !/Math\.max\(0,\s*b\)/.test(liveFn)
      && !/\.opening\s*\+/.test(liveFn)
      && !/Assigned income/i.test(liveFn),
    'live glance reprints Forecast liveCurrentBalance and does not compose A + max(0, B)');
}

console.log('\n=== 7. Payday-day live refresh prefers the recorded snapshot ===');
{
  const sameDayLive = 2750;
  const priorOpeningDate = '2026-08-19';
  const withSnap = basePlan({
    startingCash: hubCash(sameDayLive),
    opening: {
      asOf: PAYDAY,
      priorAsOf: priorOpeningDate,
      paydaySnapshot: { periodStart: PAYDAY, asOf: PAYDAY, opening: OPENING },
      representedEvents: [{ id: 'payroll', date: PAYDAY }],
    },
  });
  const withAdvice = recommend(withSnap, PAYDAY);
  const withActive = period(withAdvice.defaultView, 'this-pay-period');
  const independentAfter = PERIOD_INCOME;
  ok(near(withAdvice.defaultView.liveCurrentBalance, sameDayLive),
    'payday-day live Current Balance follows post-event provider cash');
  ok(withActive.openingSource === 'snapshot'
      && near(withActive.opening, OPENING)
      && !near(withActive.opening, sameDayLive),
    'recorded payday snapshot wins over same-calendar-day live cash');
  ok(near(withActive.available, independentAfter)
      && near(withActive.available, withActive.incomeTotal),
    'independent Dale + Amanda still equals Payday balance');
  ok(withActive.openingSource !== 'payday-morning',
    'live-advanced payday cash is not labelled payday-morning');

  const noSnap = basePlan({
    startingCash: hubCash(sameDayLive),
    opening: {
      asOf: PAYDAY,
      priorAsOf: priorOpeningDate,
      representedEvents: [{ id: 'payroll', date: PAYDAY }],
    },
  });
  const closed = recommend(noSnap, PAYDAY);
  const closedActive = period(closed.defaultView, 'this-pay-period');
  ok(near(closed.defaultView.liveCurrentBalance, sameDayLive),
    'payday-day fail-closed still publishes live Current Balance');
  ok(closedActive.openingKnown !== true && closedActive.opening == null
      && closedActive.incomeAdded == null,
    'live-advanced payday without a snapshot fails closed on the opening');
  ok(near(closedActive.available, PERIOD_INCOME),
    'Payday balance still publishes the income identity');
}

console.log('\n=== 8. Null or empty snapshot openings fail closed ===');
{
  const laterLive = LIVE_LATER;
  const cases = [
    ['null', null],
    ['empty string', ''],
    ['whitespace', '   '],
    ['non-numeric', 'unknown'],
  ];
  for (const [label, opening] of cases) {
    const plan = basePlan({
      startingCash: hubCash(laterLive),
      opening: {
        asOf: MID,
        priorAsOf: PAYDAY,
        paydaySnapshot: { periodStart: PAYDAY, asOf: PAYDAY, opening },
        representedEvents: [],
      },
    });
    const advice = recommend(plan, MID);
    const active = period(advice.defaultView, 'this-pay-period');
    ok(near(advice.defaultView.liveCurrentBalance, laterLive),
      label + ': live Current Balance still publishes');
    ok(active.openingKnown !== true && active.opening == null
        && active.incomeAdded == null,
      label + ': incomplete snapshot fails closed instead of $0 opening');
    ok(active.opening !== 0 && near(active.available, PERIOD_INCOME),
      label + ': does not invent a $0 opening; Payday balance remains the income identity');
  }

  const zeroSnap = basePlan({
    startingCash: hubCash(laterLive),
    opening: {
      asOf: MID,
      priorAsOf: PAYDAY,
      paydaySnapshot: { periodStart: PAYDAY, asOf: PAYDAY, opening: 0 },
      representedEvents: [],
    },
  });
  const zeroAdvice = recommend(zeroSnap, MID);
  const zeroActive = period(zeroAdvice.defaultView, 'this-pay-period');
  const independentZeroAfter = PERIOD_INCOME;
  ok(zeroActive.openingKnown === true && near(zeroActive.opening, 0)
      && near(zeroActive.available, independentZeroAfter),
    'a recorded numeric $0 opening remains a known snapshot, not a rejected null');
}

console.log('\n=== 9. Income footer does not call received snapshot income still arriving ===');
{
  const laterPlan = basePlan({
    startingCash: hubCash(LIVE_LATER),
    opening: {
      asOf: MID,
      priorAsOf: '2026-08-19',
      paydaySnapshot: { periodStart: PAYDAY, asOf: PAYDAY, opening: OPENING },
      representedEvents: [
        { id: 'payroll', date: PAYDAY },
        { id: 'amandaPayday', date: PAYDAY },
      ],
    },
  });
  const advice = recommend(laterPlan, MID);
  const active = period(advice.defaultView, 'this-pay-period');
  const html = composer.calendarWaterfallHtml(active, null, advice.paydayAllocation);
  ok(near(active.incomeAdded, PERIOD_INCOME)
      && (active.income || []).some(r => r && r.id === 'payroll' && r.alreadyInCash === true),
    'mid-period snapshot still includes received payday income in incomeAdded');
  ok(/Payday balance/.test(html) && html.includes(composer.money2(PERIOD_INCOME)),
    'income footer prints Payday balance, not a settlement claim');
  ok(!/Still arriving/.test(html),
    'received payday income in the frozen snapshot is not labelled Still arriving');
}

console.log('\n=== 10. Live representedEvents do not drop snapshot income ===');
{
  const sameDayLive = 2750;
  const plan = basePlan({
    startingCash: hubCash(sameDayLive),
    opening: {
      asOf: PAYDAY,
      priorAsOf: '2026-08-19',
      paydaySnapshot: { periodStart: PAYDAY, asOf: PAYDAY, opening: OPENING },
      representedEvents: [
        { id: 'payroll', date: PAYDAY },
        { id: 'amandaPayday', date: PAYDAY },
      ],
    },
  });
  const advice = recommend(plan, PAYDAY);
  const active = period(advice.defaultView, 'this-pay-period');
  const independentAfter = PERIOD_INCOME;
  ok(near(advice.defaultView.liveCurrentBalance, sameDayLive),
    'live Current Balance is post-event cash that already contains the paycheques');
  ok(active.openingSource === 'snapshot' && near(active.opening, OPENING),
    'recorded payday snapshot still wins over live-advanced payday cash');
  ok(near(active.incomeAdded, PERIOD_INCOME)
      && (active.income || []).some(r => r && r.id === 'payroll'),
    'live representedEvents do not erase payday income from the frozen snapshot');
  ok(near(active.available, independentAfter)
      && near(active.available, active.incomeTotal)
      && !near(active.available, OPENING)
      && !near(active.available, sameDayLive),
    'Payday balance stays period income, not the pre-income snapshot or live cash');
}

if (failures) {
  console.log(`\nFAILED ${failures}`);
  process.exit(1);
}
console.log('\nOK');
