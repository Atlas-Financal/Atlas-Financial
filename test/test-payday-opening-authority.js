'use strict';
/* Payday-cycle opening authority (systems-review repair).
 *
 * A walked payday opening is authoritative only when the
 * opening-to-payday interval is complete enough to reconcile every
 * household-cash movement, or when a recorded payday snapshot exists.
 * Scheduled income plus represented outflows is not completeness:
 * unscheduled groceries / fuel / restaurants / transfers in that gap
 * must change the opening or withhold it.
 *
 * Independent reconstruction when the gap packet is complete:
 *   dated chequing-only opening + every chequing-pool movement in the gap
 *     = frozen payday opening
 *   A designated-savings credit/debit or internal-transfer savings leg
 *   does not change that reconstructed spendable opening.
 *   Dale + Amanda + recognized Other Income = Payday balance
 * Balance After Deductions supersedes Predicted Ending Balance:
 *   displayed period income − assigned bills − Household Budget hold.
 * It publishes without a payday-boundary opening. Opening cash is not
 * a term in that remainder. Cash leftover stays internal so the next
 * period can open from cash, not from Balance After Deductions.
 * Opening cash is not a term in the paydayAllocation current-cash
 * waterfall.
 *
 * Live mid-period cash is a separate fact. The page does not add.
 * provider-observe earns paydayGapComplete from opening-to-payday
 * household-cash coverage. live-plan consumes that earned attestation
 * as paydayGapCash; a helper-only injection is not the live path.
 *
 * `node test/test-payday-opening-authority.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const Live = require('../scripts/live-plan.js');
const O = require('../scripts/provider-observe.js');
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
    `${source}\n({ calendarWaterfallHtml, calendarWaterfallsHtml, liveCurrentBalanceHtml, money2 });`,
    { Forecast: F }
  );
}

const DATED = '2026-08-19';
const PAYDAY = '2026-08-28';
const MID = '2026-09-04';
const OPENING = 1000;
const CHILD = 150;
const PRE_BILL = 40;
const DALE = 4000;
const AMANDA = 2000;
const PERIOD_BILL = 500;
const BUDGET_HOLD = 200;
const LIVE_MID = 2337.21;
const LIVE_LATER = 1800.05;
const GROCERY = 75;
const PERIOD_INCOME = roundCent(DALE + AMANDA);
const INDEPENDENT_MORNING = roundCent(OPENING + CHILD);
const INDEPENDENT_MORNING_WITH_GROCERY = roundCent(OPENING + CHILD - GROCERY);
const REMAINING_UNPAID = roundCent(PRE_BILL + PERIOD_BILL);
const AFTER_PAYDAY = PERIOD_INCOME;
const AFTER_BILLS = roundCent(AFTER_PAYDAY - REMAINING_UNPAID);
const AFTER_BUDGET = roundCent(AFTER_BILLS - BUDGET_HOLD);

function hubStartingCash(amount) {
  return {
    amount,
    breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: amount }],
  };
}

function completeGapCash(movements) {
  return {
    complete: true,
    coverageStart: '2026-08-20',
    coverageThrough: '2026-08-27',
    movements: movements || [],
  };
}

function basePlan(overrides) {
  return Object.assign({
    defaults: { targetBuffer: 0 },
    startingCash: { amount: OPENING },
    nextDollar: {
      policy: 'true-surplus-highest-interest',
      provenance: 'owner-stated',
    },
    opening: { asOf: DATED, representedEvents: [] },
    income: [
      {
        id: 'payroll', label: 'Dale', frequency: 'biweekly',
        anchor: PAYDAY, amount: DALE, confidence: 'confirmed',
      },
      {
        id: 'amandaPayday', label: 'Amanda', frequency: 'once',
        date: '2026-08-31', amount: AMANDA, confidence: 'confirmed',
      },
      {
        id: 'childBenefit', label: 'Child benefit', frequency: 'once',
        date: '2026-08-20', amount: CHILD, confidence: 'confirmed',
      },
    ],
    bills: [
      {
        id: 'pre-bill', label: 'Before payday', frequency: 'once',
        date: '2026-08-26', amount: PRE_BILL, confidence: 'confirmed',
      },
      {
        id: 'period-bill', label: 'Period bill', frequency: 'once',
        date: '2026-09-01', amount: PERIOD_BILL, confidence: 'confirmed',
      },
    ],
    obligations: [],
    commitments: [],
    budget: {
      categories: [
        {
          id: 'groceries', label: 'Groceries', class: 'essential',
          plannedPayday: BUDGET_HOLD,
        },
      ],
    },
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
    targetBuffer: plan.defaults && plan.defaults.targetBuffer,
    debts: [],
  }, extra || {}));
}

const composer = loadComposer();
const planSrc = read('public/plan.js');

console.log('=== 1. Incomplete scheduled-only gap withholds the payday opening ===');
{
  const plan = basePlan();
  const snap = F.establishPaydaySnapshot(plan, PAYDAY);
  ok(snap == null,
    'establishPaydaySnapshot withholds a scheduled-only walk; child benefit plus unpaid Aug 26 is not completeness');

  const advice = recommend(plan, MID);
  const active = period(advice.defaultView, 'this-pay-period');
  ok(active && active.start === PAYDAY && active.openingKnown !== true
      && active.opening == null,
    'mid-period dated plan withholds the reconstructed payday opening');
  ok(near(active.available, PERIOD_INCOME) && near(active.available, active.incomeTotal),
    'Payday balance still publishes the income identity when opening is withheld');
  const dale = incomeRow(active, 'payroll');
  const amanda = incomeRow(active, 'amandaPayday');
  ok(dale && near(dale.amount, DALE) && amanda && near(amanda.amount, AMANDA),
    'period income rows stay visible while the opening is withheld');
}

console.log('\n=== 2. Mid-period live cash cannot substitute for the opening ===');
{
  const livePlan = basePlan({
    startingCash: hubStartingCash(LIVE_MID),
    opening: {
      asOf: MID,
      priorAsOf: DATED,
      paydaySnapshot: { periodStart: PAYDAY, asOf: PAYDAY, opening: INDEPENDENT_MORNING },
      representedEvents: [
        { id: 'payroll', date: PAYDAY },
        { id: 'amandaPayday', date: '2026-08-31' },
        { id: 'period-bill', date: '2026-09-01' },
      ],
    },
  });
  const first = recommend(livePlan, MID);
  const active = period(first.defaultView, 'this-pay-period');
  ok(near(first.defaultView.liveCurrentBalance, LIVE_MID),
    'live Current Balance follows the mid-period observation');
  ok(active.openingSource === 'snapshot' && near(active.opening, INDEPENDENT_MORNING)
      && !near(active.opening, LIVE_MID),
    'frozen payday opening stays the walked morning figure, not $2,337.21');
  ok(near(active.available, AFTER_PAYDAY)
      && !near(active.available, roundCent(LIVE_MID + PERIOD_INCOME))
      && !near(active.available, LIVE_MID),
    'Payday balance is not live cash and is not live cash plus income');

  const laterPlan = basePlan({
    startingCash: hubStartingCash(LIVE_LATER),
    opening: {
      asOf: '2026-09-06',
      priorAsOf: DATED,
      paydaySnapshot: { periodStart: PAYDAY, asOf: PAYDAY, opening: INDEPENDENT_MORNING },
      representedEvents: [
        { id: 'payroll', date: PAYDAY },
        { id: 'amandaPayday', date: '2026-08-31' },
        { id: 'period-bill', date: '2026-09-01' },
      ],
    },
  });
  const later = recommend(laterPlan, '2026-09-06');
  const laterActive = period(later.defaultView, 'this-pay-period');
  ok(near(later.defaultView.liveCurrentBalance, LIVE_LATER)
      && !near(later.defaultView.liveCurrentBalance, LIVE_MID),
    'later live Current Balance can move');
  ok(near(laterActive.opening, INDEPENDENT_MORNING)
      && near(laterActive.opening, active.opening)
      && near(laterActive.available, active.available),
    'payday opening and Payday balance stay stable after later transactions');
}

console.log('\n=== 3. Income is counted exactly once; paid bills are not deducted again ===');
{
  const livePlan = basePlan({
    startingCash: hubStartingCash(LIVE_MID),
    opening: {
      asOf: MID,
      priorAsOf: DATED,
      paydaySnapshot: { periodStart: PAYDAY, asOf: PAYDAY, opening: INDEPENDENT_MORNING },
      representedEvents: [
        { id: 'payroll', date: PAYDAY },
        { id: 'amandaPayday', date: '2026-08-31' },
        { id: 'period-bill', date: '2026-09-01' },
      ],
    },
  });
  const advice = recommend(livePlan, MID);
  const active = period(advice.defaultView, 'this-pay-period');
  const dale = incomeRow(active, 'payroll');
  const amanda = incomeRow(active, 'amandaPayday');
  ok(dale && near(dale.amount, DALE) && dale.alreadyInCash === true,
    'received Dale row stays visible as settlement evidence');
  ok(amanda && near(amanda.amount, AMANDA),
    'Amanda period income stays on the snapshot');
  ok(near(active.incomeAdded, PERIOD_INCOME)
      && near(active.available, AFTER_PAYDAY)
      && !near(active.available, roundCent(INDEPENDENT_MORNING + PERIOD_INCOME)),
    'Dale and Amanda belong to Payday balance once, not opening plus income');
  ok(!near(active.available, roundCent(LIVE_MID + PERIOD_INCOME)),
    'the same paycheques are not added on top of live cash');
  const paid = (active.bills || []).find(r => r && r.id === 'period-bill');
  ok(paid && paid.status === 'PAID' && near(paid.remaining, 0),
    'represented period bill stays listed as paid');
  ok(near(active.remainingBills, PRE_BILL)
      && near(active.paidBills, PERIOD_BILL)
      && near(active.periodBillLoad, REMAINING_UNPAID)
      && near(active.afterBills, roundCent(
        active.incomeTotal - active.periodBillLoad)),
    'paid period bill still leaves the frozen snapshot; unpaid pre-payday once-bill stays reserved once; afterBills is incomeTotal − periodBillLoad');
}

console.log('\n=== 4. Represented pre-payday outflow is not a completeness substitute ===');
{
  const plan = basePlan({
    opening: {
      asOf: DATED,
      representedEvents: [{ id: 'pre-bill', date: '2026-08-26' }],
    },
  });
  ok(F.establishPaydaySnapshot(plan, PAYDAY) == null,
    'a represented scheduled bill without complete gap cash still withholds');
  const paidMorning = roundCent(OPENING + CHILD - PRE_BILL);
  const livePlan = basePlan({
    startingCash: hubStartingCash(LIVE_MID),
    opening: {
      asOf: MID,
      priorAsOf: DATED,
      paydaySnapshot: {
        periodStart: PAYDAY, asOf: PAYDAY, opening: paidMorning,
      },
      representedEvents: [{ id: 'pre-bill', date: '2026-08-26' }],
    },
  });
  const advice = recommend(livePlan, MID);
  const active = period(advice.defaultView, 'this-pay-period');
  const pre = (active.bills || []).find(r => r && r.id === 'pre-bill');
  ok(near(active.opening, paidMorning)
      && (!pre || pre.status === 'PAID' || near(pre.remaining, 0)),
    'a recorded snapshot still keeps the represented Aug 26 bill inside payday morning');
  ok(near(active.remainingBills, PERIOD_BILL)
      && near(active.available, PERIOD_INCOME)
      && near(active.afterRemainingBills, roundCent(
        active.incomeTotal - active.periodBillLoad)),
    'Payday balance is period income; BAD is income-led and does not re-deduct the represented pre-payday bill (periodBillLoad already excludes settled-in-opening)');
  const daleUnproven = incomeRow(active, 'payroll');
  const amandaUnproven = incomeRow(active, 'amandaPayday');
  ok(daleUnproven && daleUnproven.settlement === 'relied-upon'
      && daleUnproven.notReliedUpon !== true,
    'Dale stays relied-upon after payday from owner policy, not from the pre-payday bill');
  ok(amandaUnproven && amandaUnproven.notReliedUpon === true,
    'pre-payday bill settlement does not prove Amanda receipt');
}

console.log('\n=== 5. Live-advanced cash without a walkable dated opening still fails closed ===');
{
  const orphan = basePlan({
    startingCash: hubStartingCash(LIVE_MID),
    opening: { asOf: MID, priorAsOf: PAYDAY, representedEvents: [] },
  });
  const closed = recommend(orphan, MID);
  const active = period(closed.defaultView, 'this-pay-period');
  ok(near(closed.defaultView.liveCurrentBalance, LIVE_MID),
    'fail-closed mid-period still publishes live Current Balance');
  ok(active.openingKnown !== true && active.opening == null,
    'live-advanced cash with no dated pre-payday opening still fails closed');
  ok(near(active.available, PERIOD_INCOME),
    'Payday balance still publishes the income identity');
  ok(F.establishPaydaySnapshot(orphan, PAYDAY) == null,
    'establishPaydaySnapshot refuses live-advanced starting cash');
}

console.log('\n=== 6. Incomplete gap withholds leftovers; complete gap is Forecast-owned ===');
{
  const incomplete = recommend(basePlan(), MID);
  const incompleteActive = period(incomplete.defaultView, 'this-pay-period');
  const incompleteHtml = composer.calendarWaterfallsHtml(
    incomplete.defaultView, 'this-pay-period', {
      applied: true,
      operatingPlan: 'live',
      fetchedAt: '2026-09-04T18:00:00.000Z',
      observedAsOf: MID,
      observedCash: {
        complete: true,
        asOf: MID,
        accounts: [
          { id: 'chequing-a', value: LIVE_MID, evidenceDate: MID },
        ],
      },
    }, incomplete.paydayAllocation);
  ok(incompleteActive.openingKnown !== true && incompleteActive.opening == null,
    'incomplete gap withholds the payday opening');
  ok(near(incompleteActive.available, PERIOD_INCOME)
      && near(incompleteActive.available, incompleteActive.incomeTotal),
    'Payday balance still publishes the income identity when opening is withheld');
  ok(/PAYDAY OPENING IS NOT RECORDED/i.test(incompleteHtml)
      || /Opening is not recorded/i.test(incompleteHtml)
      || /—/.test(incompleteHtml),
    'page does not invent leftover dollars for an incomplete gap');

  const plan = basePlan();
  const advice = recommend(plan, MID, {
    paydayGapCash: completeGapCash([
      { date: '2026-08-20', amount: CHILD, accountRole: 'household-cash' },
    ]),
  });
  const active = period(advice.defaultView, 'this-pay-period');
  const html = composer.calendarWaterfallsHtml(
    advice.defaultView, 'this-pay-period', {
      applied: true,
      operatingPlan: 'live',
      fetchedAt: '2026-09-04T18:00:00.000Z',
      observedAsOf: MID,
      observedCash: {
        complete: true,
        asOf: MID,
        accounts: [
          { id: 'chequing-a', value: LIVE_MID, evidenceDate: MID },
        ],
      },
    }, advice.paydayAllocation);
  ok(active.openingKnown === true && active.openingSource === 'cutover-walk'
      && near(active.opening, INDEPENDENT_MORNING)
      && near(active.available, AFTER_PAYDAY)
      && near(active.afterRemainingBills, roundCent(
        active.incomeTotal - active.periodBillLoad))
      && near(active.afterHouseholdBudget, roundCent(
        active.incomeTotal - active.periodBillLoad - active.budgetHold)),
    'complete gap publishes Payday balance as Dale + Amanda; leftover is income − bills − hold');
  ok(html.includes(composer.money2(active.available))
      && html.includes(composer.money2(active.afterRemainingBills))
      && html.includes(composer.money2(active.afterHouseholdBudget)),
    'page prints the Forecast leftover balances instead of em dashes');
  ok(!/PAYDAY OPENING IS NOT RECORDED/i.test(html)
      && !/Opening is not recorded/i.test(html),
    'complete walked opening does not print the missing-snapshot warning');
  const waterfallFn = grab(planSrc, /^function calendarWaterfallHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallHtml');
  const incomeFn = grab(planSrc, /^function calendarIncomeHtml\([\s\S]*?\n\}$/m, 'calendarIncomeHtml');
  ok(/period\.available/.test(incomeFn) && /Payday balance/i.test(incomeFn)
      && /period\.afterBills/.test(waterfallFn)
      && /period\.afterHouseholdBudget/.test(waterfallFn)
      && !/\.opening\s*\+/.test(waterfallFn)
      && !/incomeAdded/.test(waterfallFn),
    'plan.js renders Forecast leftovers; it does not add opening + income');
}

console.log('\n=== 7. Unscheduled pre-payday outflow must change the opening or withhold it ===');
{
  const plan = basePlan();
  const scheduledOnly = F.establishPaydaySnapshot(plan, PAYDAY);
  const groceryIncomplete = F.establishPaydaySnapshot(plan, PAYDAY, {
    paydayGapCash: {
      complete: false,
      coverageStart: '2026-08-20',
      coverageThrough: '2026-08-27',
      movements: [
        { date: '2026-08-20', amount: CHILD, accountRole: 'household-cash' },
        { date: '2026-08-25', amount: -GROCERY, accountRole: 'household-cash' },
      ],
    },
  });
  const withoutGrocery = F.establishPaydaySnapshot(plan, PAYDAY, {
    paydayGapCash: completeGapCash([
      { date: '2026-08-20', amount: CHILD, accountRole: 'household-cash' },
    ]),
  });
  const withGrocery = F.establishPaydaySnapshot(plan, PAYDAY, {
    paydayGapCash: completeGapCash([
      { date: '2026-08-20', amount: CHILD, accountRole: 'household-cash' },
      { date: '2026-08-25', amount: -GROCERY, accountRole: 'household-cash' },
    ]),
  });
  ok(scheduledOnly == null && groceryIncomplete == null,
    'unscheduled grocery without proven completeness withholds; it does not equal the scheduled-only opening');
  ok(withoutGrocery && near(withoutGrocery.opening, INDEPENDENT_MORNING),
    'complete gap without the grocery independently equals 1000 + 150');
  ok(withGrocery && near(withGrocery.opening, INDEPENDENT_MORNING_WITH_GROCERY)
      && !near(withGrocery.opening, withoutGrocery.opening)
      && !near(withGrocery.opening, INDEPENDENT_MORNING),
    'complete gap incorporates the $75 grocery from trusted evidence; opening is not the no-grocery figure');

  const liveLater = 1800.05;
  const reversed = F.establishPaydaySnapshot(basePlan({
    startingCash: { amount: liveLater },
    opening: { asOf: DATED, representedEvents: [] },
  }), PAYDAY);
  ok(reversed == null && !near(INDEPENDENT_MORNING_WITH_GROCERY, liveLater),
    'repair does not reverse-walk later live cash to invent the grocery-adjusted opening');

  const advice = recommend(plan, MID, {
    paydayGapCash: completeGapCash([
      { date: '2026-08-20', amount: CHILD, accountRole: 'household-cash' },
      { date: '2026-08-25', amount: -GROCERY, accountRole: 'household-cash' },
    ]),
  });
  const active = period(advice.defaultView, 'this-pay-period');
  ok(active.openingKnown === true
      && near(active.opening, INDEPENDENT_MORNING_WITH_GROCERY)
      && near(active.available, PERIOD_INCOME)
      && near(active.opening, INDEPENDENT_MORNING_WITH_GROCERY),
    'opening follows the grocery-adjusted complete walk; Payday balance is period income');
}

const LIVE_A = 400;
const LIVE_B = 200;
const LIVE_SAVINGS = 50;
const LIVE_SUM = roundCent(LIVE_A + LIVE_B + LIVE_SAVINGS);
const LIVE_CHEQUING = roundCent(LIVE_A + LIVE_B);
const OVERLAY_DATED_CHEQUING = roundCent(600 + 300);
const OVERLAY_MORNING = roundCent(OVERLAY_DATED_CHEQUING + CHILD);
const OVERLAY_MORNING_WITH_GROCERY = roundCent(OVERLAY_DATED_CHEQUING + CHILD - GROCERY);

function overlayCanonical() {
  return {
    meta: { asOf: DATED },
    plan: basePlan({
      startingCash: {
        amount: OPENING,
        breakdown: [
          { id: 'chequing-a', value: 600 },
          { id: 'chequing-b', value: 300 },
          { id: 'savings', value: 100 },
        ],
      },
    }),
    debts: [],
  };
}

function overlayCashRow(id, canonicalValue, evidenceValue) {
  return {
    fact: 'posted-balance',
    status: 'CHANGE',
    canonicalTarget: 'cash:' + id,
    canonicalValue,
    evidenceValue,
    evidenceDate: MID,
    dateRelation: 'canonical-older',
    unknown: false,
  };
}

function overlayReport(opts) {
  const o = opts || {};
  return {
    writesCanonicalState: false,
    fetchedAt: '2026-09-04T18:00:00.000Z',
    pendingCoverage: {
      complete: true,
      basis: 'is_pending-unbounded',
      hasMore: false,
      startDate: null,
      endDate: null,
    },
    transactionWindow: o.window || {
      startDate: '2026-08-20',
      endDate: MID,
      complete: true,
      hasMore: false,
      truncated: false,
    },
    mapped: [],
    unmapped: [],
    representedEventCandidates: [],
    reconciliation: {
      rows: [
        overlayCashRow('chequing-a', 600, LIVE_A),
        overlayCashRow('chequing-b', 300, LIVE_B),
        overlayCashRow('savings', 100, LIVE_SAVINGS),
      ],
    },
    currentPeriodActuals: Object.prototype.hasOwnProperty.call(o, 'actuals')
      ? o.actuals
      : {
        schema: 'atlas-current-period-actuals/v1',
        observationAsOf: MID,
        coverageStart: (o.coverageStart != null) ? o.coverageStart : '2026-08-20',
        coverageThrough: (o.coverageThrough != null) ? o.coverageThrough : MID,
        pendingCoverage: 'complete',
        transactionCoverage: o.transactionCoverage || 'complete',
        paydayGapComplete: o.paydayGapComplete === true,
        representedActuals: [],
        transactions: o.transactions || [],
      },
  };
}

function overlayAdvice(data) {
  return F.recommend(data.plan, MID, {
    targetBuffer: data.plan.defaults && data.plan.defaults.targetBuffer,
    debts: data.debts || [],
    operatingPlan: data.liveOverlay && data.liveOverlay.operatingPlan,
  });
}

console.log('\n=== 8. live overlay retains a complete gap packet and withholds an incomplete one ===');
{
  const liveSrc = read('scripts/live-plan.js');
  ok(/paydayGapCashFromReport/.test(liveSrc)
      && /paydayGapCash:\s*paydayGapCashFromReport/.test(liveSrc),
    'retainPaydaySnapshot passes incumbent report evidence as paydayGapCash');

  const completeTxs = [
    { date: '2026-08-20', amount: -CHILD, accountRole: 'household-cash', pending: false },
    { date: '2026-08-25', amount: GROCERY, accountRole: 'household-cash', pending: false },
  ];
  const complete = Live.overlayLiveState({
    data: overlayCanonical(),
    report: overlayReport({
      transactions: completeTxs,
      paydayGapComplete: true,
    }),
  });
  const completeSnap = complete.data.plan.opening
    && complete.data.plan.opening.paydaySnapshot;
  const completeAdvice = overlayAdvice(complete.data);
  const completeActive = period(completeAdvice.defaultView, 'this-pay-period');
  const completeHtml = composer.calendarWaterfallsHtml(
    completeAdvice.defaultView, 'this-pay-period', complete.data.liveOverlay,
    completeAdvice.paydayAllocation);
  ok(complete.data.liveOverlay && complete.data.liveOverlay.applied === true
      && near(F.startingCashAmount(complete.data.plan), LIVE_CHEQUING),
    'complete-gap fixture still overlays mid-period live cash');
  ok(completeSnap && completeSnap.periodStart === PAYDAY
      && completeSnap.asOf === PAYDAY
      && near(completeSnap.opening, OVERLAY_MORNING_WITH_GROCERY)
      && !near(completeSnap.opening, LIVE_SUM)
      && !near(completeSnap.opening, OVERLAY_MORNING),
    'overlayLiveState retains the grocery-adjusted complete paydaySnapshot, not live cash or the no-grocery walk');
  ok(completeActive && completeActive.openingKnown === true
      && near(completeActive.opening, OVERLAY_MORNING_WITH_GROCERY)
      && near(completeActive.available, PERIOD_INCOME)
      && near(completeActive.afterRemainingBills, roundCent(
        completeActive.incomeTotal - completeActive.periodBillLoad))
      && near(completeActive.afterHouseholdBudget, roundCent(
        completeActive.incomeTotal - completeActive.periodBillLoad
        - completeActive.budgetHold))
      && !near(completeActive.afterHouseholdBudget, LIVE_CHEQUING)
      && !near(completeActive.afterHouseholdBudget, completeActive.opening),
    'live This Payday leftover is Balance After Deductions, not live mid-period cash and not the retained opening');
  ok(completeActive.income.every(row => row.id !== 'amandaPayday' || row.notReliedUpon === true),
    'complete pre-payday cash coverage does not prove later Amanda receipt');
  const completeDale = incomeRow(completeActive, 'payroll');
  ok(completeDale && completeDale.settlement === 'relied-upon',
    'Dale remains relied-upon after payday from owner policy, not from gap coverage');
  ok(completeHtml.includes(composer.money2(completeActive.available))
      && completeHtml.includes(composer.money2(completeActive.afterRemainingBills))
      && completeHtml.includes(composer.money2(completeActive.afterHouseholdBudget))
      && !/PAYDAY OPENING IS NOT RECORDED/i.test(completeHtml),
    'live This Payday waterfall renders the Forecast leftover dollars');

  const incomplete = Live.overlayLiveState({
    data: overlayCanonical(),
    report: overlayReport({
      transactions: completeTxs,
      window: {
        startDate: '2026-08-20',
        endDate: MID,
        complete: false,
        hasMore: false,
        truncated: true,
      },
      transactionCoverage: 'truncated',
    }),
  });
  const incompleteSnap = incomplete.data.plan.opening
    && incomplete.data.plan.opening.paydaySnapshot;
  const incompleteAdvice = overlayAdvice(incomplete.data);
  const incompleteActive = period(incompleteAdvice.defaultView, 'this-pay-period');
  const incompleteHtml = composer.calendarWaterfallsHtml(
    incompleteAdvice.defaultView, 'this-pay-period', incomplete.data.liveOverlay,
    incompleteAdvice.paydayAllocation);
  ok(incomplete.data.liveOverlay && incomplete.data.liveOverlay.applied === true
      && near(F.startingCashAmount(incomplete.data.plan), LIVE_CHEQUING),
    'incomplete-gap fixture still overlays mid-period live cash');
  ok(!incompleteSnap, 'truncated transaction window does not retain a paydaySnapshot');
  ok(incompleteActive && incompleteActive.openingKnown !== true
      && incompleteActive.opening == null
      && near(incompleteActive.available, PERIOD_INCOME),
    'live path with incomplete gap evidence still withholds the leftover chain');
  ok(/PAYDAY OPENING IS NOT RECORDED/i.test(incompleteHtml)
      || /Opening is not recorded/i.test(incompleteHtml)
      || /—/.test(incompleteHtml),
    'incomplete live path does not invent leftover dollars');

  const windowOnly = Live.overlayLiveState({
    data: overlayCanonical(),
    report: overlayReport({ transactions: completeTxs }),
  });
  ok(!(windowOnly.data.plan.opening
      && windowOnly.data.plan.opening.paydaySnapshot),
    'a paginated-complete current-period window without paydayGapComplete still withholds');

  const missingActuals = Live.overlayLiveState({
    data: overlayCanonical(),
    report: overlayReport({ actuals: null }),
  });
  ok(!(missingActuals.data.plan.opening
      && missingActuals.data.plan.opening.paydaySnapshot),
    'overlay without currentPeriodActuals still withholds the opening');

  const shortCoverage = Live.overlayLiveState({
    data: overlayCanonical(),
    report: overlayReport({
      transactions: completeTxs,
      coverageStart: '2026-08-21',
    }),
  });
  ok(!(shortCoverage.data.plan.opening
      && shortCoverage.data.plan.opening.paydaySnapshot),
    'coverage that starts after the first gap day still withholds');
}

function observeMap() {
  return {
    schema: 'atlas-provider-account-map/v1',
    owns: 'Synthetic payday-gap completeness map. Fixture IDs 1001–1003 are not live provider IDs.',
    does_not_own: 'Financial values, permission to write data.json, Forecast, or live owner-observed IDs.',
    provider: 'lunchmoney',
    scope: 'fixture',
    mappings: [
      { providerAccountId: '1001', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
      { providerAccountId: '1002', canonical: { collection: 'cash', id: 'chequing-b' }, atlasRole: 'household-cash' },
      { providerAccountId: '1003', canonical: { collection: 'cash', id: 'savings' }, atlasRole: 'household-cash' },
    ],
  };
}

function observeAccounts() {
  return [
    { id: 1001, name: 'Fixture Chequing A', type: 'cash', balance: LIVE_A, updated_at: '2026-09-04T17:55:00.000Z', balance_last_update: '2026-09-04T17:55:00.000Z' },
    { id: 1002, name: 'Fixture Chequing B', type: 'cash', balance: LIVE_B, updated_at: '2026-09-04T17:55:00.000Z', balance_last_update: '2026-09-04T17:55:00.000Z' },
    { id: 1003, name: 'Fixture Savings', type: 'cash', balance: LIVE_SAVINGS, updated_at: '2026-09-04T17:55:00.000Z', balance_last_update: '2026-09-04T17:55:00.000Z' },
  ];
}

function observeGapTransactions() {
  return [
    { id: 501, account_id: 1001, date: '2026-08-20', amount: -CHILD, is_pending: false, payee: 'CHILD TAX BEN CCB' },
    { id: 502, account_id: 1001, date: '2026-08-25', amount: GROCERY, is_pending: false, payee: 'SYNTHETIC GROCER' },
  ];
}

function observePayload(extra) {
  const o = extra || {};
  return {
    provider: 'lunchmoney',
    fetchedAt: '2026-09-04T18:00:00.000Z',
    pendingCoverage: Object.prototype.hasOwnProperty.call(o, 'pendingCoverage')
      ? o.pendingCoverage
      : {
        complete: true,
        basis: O.PENDING_COVERAGE_BASIS,
        hasMore: false,
        truncated: false,
      },
    transactionWindow: o.window || {
      startDate: '2026-08-20',
      endDate: MID,
      complete: true,
      hasMore: false,
      truncated: false,
    },
    accounts: o.accounts || observeAccounts(),
    transactions: o.transactions || observeGapTransactions(),
  };
}

function observeThenOverlay(payload, map) {
  return Live.fromObservation({
    data: overlayCanonical(),
    payload,
    accountMap: map || observeMap(),
  });
}

console.log('\n=== 9. observer earns paydayGapComplete; overlay consumes the produced packet ===');
{
  const observeSrc = read('scripts/provider-observe.js');
  ok(/function paydayGapCompleteFromEvidence/.test(observeSrc)
      && /paydayGapComplete:\s*paydayGapCompleteFromEvidence/.test(observeSrc)
      && !/paydayGapComplete:\s*(true|opts|packet|report)/.test(
        observeSrc.replace(/paydayGapComplete:\s*paydayGapCompleteFromEvidence[\s\S]*?\),/, '')),
    'sanitizedCurrentPeriodActuals earns paydayGapComplete from evidence, not a caller flag');

  const complete = observeThenOverlay(observePayload());
  const completePacket = complete.report.currentPeriodActuals;
  const completeSnap = complete.data.plan.opening
    && complete.data.plan.opening.paydaySnapshot;
  const completeAdvice = overlayAdvice(complete.data);
  const completeActive = period(completeAdvice.defaultView, 'this-pay-period');
  ok(completePacket && completePacket.paydayGapComplete === true
      && O.currentPeriodActualsLooksSanitized(completePacket),
    'observe earns paydayGapComplete on a fetch-complete window covering the gap');
  ok(complete.data.liveOverlay && complete.data.liveOverlay.applied === true
      && near(F.startingCashAmount(complete.data.plan), LIVE_CHEQUING),
    'complete observe→overlay path still overlays mid-period live cash');
  ok(completeSnap && completeSnap.periodStart === PAYDAY
      && completeSnap.asOf === PAYDAY
      && near(completeSnap.opening, OVERLAY_MORNING_WITH_GROCERY)
      && !near(completeSnap.opening, LIVE_SUM)
      && !near(completeSnap.opening, OVERLAY_MORNING),
    'produced complete packet retains the grocery-adjusted paydaySnapshot, not live cash');
  ok(completeActive && completeActive.openingKnown === true
      && near(completeActive.opening, OVERLAY_MORNING_WITH_GROCERY)
      && near(completeActive.available, PERIOD_INCOME)
      && near(completeActive.afterRemainingBills, roundCent(
        completeActive.incomeTotal - completeActive.periodBillLoad))
      && near(completeActive.afterHouseholdBudget, roundCent(
        completeActive.incomeTotal - completeActive.periodBillLoad
        - completeActive.budgetHold))
      && !near(completeActive.afterHouseholdBudget, LIVE_CHEQUING)
      && !near(completeActive.afterHouseholdBudget, completeActive.opening),
    'observe→overlay leftover is Balance After Deductions, not live mid-period cash and not the produced opening');
  ok(completeActive.income.every(row => row.id !== 'amandaPayday' || row.notReliedUpon === true),
    'observed gap movements do not manufacture later Amanda settlement');
  const observedDale = incomeRow(completeActive, 'payroll');
  ok(observedDale && observedDale.settlement === 'relied-upon',
    'Dale remains relied-upon after payday from owner policy, not from observed gap movements');

  const truncated = observeThenOverlay(observePayload({
    window: {
      startDate: '2026-08-20',
      endDate: MID,
      complete: false,
      hasMore: false,
      truncated: true,
    },
  }));
  ok(truncated.report.currentPeriodActuals
      && truncated.report.currentPeriodActuals.paydayGapComplete !== true
      && !(truncated.data.plan.opening && truncated.data.plan.opening.paydaySnapshot),
    'truncated posted window does not earn the attestation and withholds the opening');

  const short = observeThenOverlay(observePayload({
    window: {
      startDate: '2026-08-21',
      endDate: MID,
      complete: true,
      hasMore: false,
      truncated: false,
    },
  }));
  ok(short.report.currentPeriodActuals
      && short.report.currentPeriodActuals.paydayGapComplete !== true
      && !(short.data.plan.opening && short.data.plan.opening.paydaySnapshot),
    'window that misses the first gap day does not earn the attestation');

  const unmapped = observeThenOverlay(observePayload({
    accounts: observeAccounts().concat([{
      id: 1999, name: 'Unmapped Extra', type: 'cash', balance: 10,
      updated_at: '2026-09-04T17:55:00.000Z', balance_last_update: '2026-09-04T17:55:00.000Z',
    }]),
    transactions: observeGapTransactions().concat([{
      id: 599, account_id: 1999, date: '2026-08-22', amount: 12, is_pending: false,
      payee: 'UNMAPPED DEBIT',
    }]),
  }));
  ok(unmapped.report.currentPeriodActuals
      && unmapped.report.currentPeriodActuals.paydayGapComplete !== true
      && !(unmapped.data.plan.opening && unmapped.data.plan.opening.paydaySnapshot),
    'unmapped household-cash evidence does not earn the attestation');

  const pending = observeThenOverlay(observePayload({
    transactions: observeGapTransactions().concat([{
      id: 503, account_id: 1001, date: '2026-08-26', amount: 20,
      is_pending: true, payee: 'PENDING SHOP',
    }]),
  }));
  ok(pending.report.currentPeriodActuals
      && pending.report.currentPeriodActuals.paydayGapComplete !== true
      && !(pending.data.plan.opening && pending.data.plan.opening.paydaySnapshot),
    'pending-unproven gap cash does not earn the attestation');

  const missingPending = observeThenOverlay(observePayload({
    pendingCoverage: null,
  }));
  ok(missingPending.report.currentPeriodActuals
      && missingPending.report.currentPeriodActuals.paydayGapComplete !== true
      && !(missingPending.data.plan.opening
        && missingPending.data.plan.opening.paydaySnapshot),
    'missing pending coverage does not earn the attestation');
}

console.log('\n=== 10. Designated savings in the gap does not change spendable payday opening ===');
{
  const SAVINGS_IN = 200;
  const TRANSFER = 40;
  const independentAfterTransfer = roundCent(OVERLAY_MORNING_WITH_GROCERY - TRANSFER);
  const ifSavingsSpent = roundCent(OVERLAY_MORNING_WITH_GROCERY + SAVINGS_IN);
  const chequingGap = [
    { date: '2026-08-20', amount: CHILD, accountRole: 'household-cash', atlasAccountId: 'chequing-a' },
    { date: '2026-08-25', amount: -GROCERY, accountRole: 'household-cash', atlasAccountId: 'chequing-a' },
  ];
  const plan = overlayCanonical().plan;
  const chequingOnly = F.establishPaydaySnapshot(plan, PAYDAY, {
    paydayGapCash: completeGapCash(chequingGap),
  });
  const withSavingsCredit = F.establishPaydaySnapshot(plan, PAYDAY, {
    paydayGapCash: completeGapCash(chequingGap.concat([{
      date: '2026-08-22', amount: SAVINGS_IN, accountRole: 'household-cash',
      atlasAccountId: 'savings',
    }])),
  });
  const withTransfer = F.establishPaydaySnapshot(plan, PAYDAY, {
    paydayGapCash: completeGapCash(chequingGap.concat([
      {
        date: '2026-08-22', amount: -TRANSFER, accountRole: 'household-cash',
        atlasAccountId: 'chequing-a',
      },
      {
        date: '2026-08-22', amount: TRANSFER, accountRole: 'household-cash',
        atlasAccountId: 'savings',
      },
    ])),
  });
  ok(chequingOnly && near(chequingOnly.opening, OVERLAY_MORNING_WITH_GROCERY),
    'independent chequing-only reconstruction is dated chequing + child − grocery');
  ok(withSavingsCredit && near(withSavingsCredit.opening, OVERLAY_MORNING_WITH_GROCERY)
      && !near(withSavingsCredit.opening, ifSavingsSpent),
    'a designated-savings credit in a complete gap does not change the spendable payday opening');
  ok(withTransfer && near(withTransfer.opening, independentAfterTransfer)
      && !near(withTransfer.opening, OVERLAY_MORNING_WITH_GROCERY)
      && !near(withTransfer.opening, OVERLAY_MORNING_WITH_GROCERY + TRANSFER),
    'a chequing→savings transfer reduces the opening by the chequing leg only; the savings leg does not cancel it');

  const liveSrc = read('scripts/live-plan.js');
  ok(/atlasAccountId/.test(liveSrc)
      && /movement\.atlasAccountId/.test(liveSrc),
    'paydayGapCashFromReport preserves account identity for Forecast');

  const completeTxs = [
    { date: '2026-08-20', amount: -CHILD, accountRole: 'household-cash', atlasAccountId: 'chequing-a', pending: false },
    { date: '2026-08-25', amount: GROCERY, accountRole: 'household-cash', atlasAccountId: 'chequing-a', pending: false },
  ];
  const savingsCreditTx = {
    date: '2026-08-22', amount: -SAVINGS_IN, accountRole: 'household-cash',
    atlasAccountId: 'savings', pending: false,
  };
  const transferTxs = [
    {
      date: '2026-08-22', amount: TRANSFER, accountRole: 'household-cash',
      atlasAccountId: 'chequing-a', pending: false,
    },
    {
      date: '2026-08-22', amount: -TRANSFER, accountRole: 'household-cash',
      atlasAccountId: 'savings', pending: false,
    },
  ];
  const savingsOverlay = Live.overlayLiveState({
    data: overlayCanonical(),
    report: overlayReport({
      transactions: completeTxs.concat([savingsCreditTx]),
      paydayGapComplete: true,
    }),
  });
  const savingsSnap = savingsOverlay.data.plan.opening
    && savingsOverlay.data.plan.opening.paydaySnapshot;
  const savingsPacket = Live.paydayGapCashFromReport(
    overlayReport({
      transactions: completeTxs.concat([savingsCreditTx]),
      paydayGapComplete: true,
    }),
    overlayCanonical().plan,
    PAYDAY
  );
  ok(savingsSnap && near(savingsSnap.opening, OVERLAY_MORNING_WITH_GROCERY)
      && !near(savingsSnap.opening, ifSavingsSpent),
    'live overlay complete-gap snapshot ignores a designated-savings credit');
  ok(savingsPacket && savingsPacket.complete === true
      && savingsPacket.movements.some(m => m && m.atlasAccountId === 'savings'
        && near(m.amount, SAVINGS_IN))
      && savingsPacket.movements.some(m => m && m.atlasAccountId === 'chequing-a'
        && near(m.amount, -GROCERY)),
    'the gap packet still carries the savings movement as evidence; Forecast does not spend it');

  const transferOverlay = Live.overlayLiveState({
    data: overlayCanonical(),
    report: overlayReport({
      transactions: completeTxs.concat(transferTxs),
      paydayGapComplete: true,
    }),
  });
  const transferSnap = transferOverlay.data.plan.opening
    && transferOverlay.data.plan.opening.paydaySnapshot;
  ok(transferSnap && near(transferSnap.opening, independentAfterTransfer)
      && !near(transferSnap.opening, OVERLAY_MORNING_WITH_GROCERY),
    'live overlay applies the chequing transfer leg and ignores the savings leg');

  const observeSavings = observeThenOverlay(observePayload({
    transactions: observeGapTransactions().concat([{
      id: 510, account_id: 1003, date: '2026-08-22', amount: -SAVINGS_IN,
      is_pending: false, payee: 'SYNTHETIC SAVINGS CREDIT',
    }]),
  }));
  const observeSavingsSnap = observeSavings.data.plan.opening
    && observeSavings.data.plan.opening.paydaySnapshot;
  ok(observeSavings.report.currentPeriodActuals
      && observeSavings.report.currentPeriodActuals.paydayGapComplete === true
      && observeSavingsSnap
      && near(observeSavingsSnap.opening, OVERLAY_MORNING_WITH_GROCERY)
      && !near(observeSavingsSnap.opening, ifSavingsSpent),
    'observe→overlay still earns completeness; a savings credit does not move the spendable opening');

  const observeTransfer = observeThenOverlay(observePayload({
    transactions: observeGapTransactions().concat([
      {
        id: 511, account_id: 1001, date: '2026-08-22', amount: TRANSFER,
        is_pending: false, payee: 'TFR-TO SAVINGS',
      },
      {
        id: 512, account_id: 1003, date: '2026-08-22', amount: -TRANSFER,
        is_pending: false, payee: 'TFR-FR CHEQUING',
      },
    ]),
  }));
  const observeTransferSnap = observeTransfer.data.plan.opening
    && observeTransfer.data.plan.opening.paydaySnapshot;
  ok(observeTransfer.report.currentPeriodActuals
      && observeTransfer.report.currentPeriodActuals.paydayGapComplete === true
      && observeTransferSnap
      && near(observeTransferSnap.opening, independentAfterTransfer)
      && !near(observeTransferSnap.opening, OVERLAY_MORNING_WITH_GROCERY),
    'observe→overlay still applies a chequing transfer outflow; the savings credit leg does not cancel it');
}

// The mixed breakdown retains reported reserve stock, while Forecast's
// spendable opening is chequing-only. A reserve mapping must stay a reserve.
{
  const fixture = require('./fixtures/payday-gap-reserve-data');
  const cases = [
    ['mixed purpose reserve', () => {}, true],
    ['large reserve cannot rescue the opening', i => { i.plan.startingCash.breakdown.find(r=>r.id==='savings').value=999999; }, true],
    ['legacy savings cash mapping remains compatible', i => { i.accountMap.mappings.find(m=>m.canonical.id==='savings').atlasRole='household-cash'; }, true],
    ['missing operating A mapping', i => { i.accountMap.mappings=i.accountMap.mappings.filter(m=>m.canonical.id!=='chequing-a'); }, false],
    ['missing operating B mapping', i => { i.accountMap.mappings=i.accountMap.mappings.filter(m=>m.canonical.id!=='chequing-b'); }, false],
    ['operating account mapped as reserve', i => { i.accountMap.mappings.find(m=>m.canonical.id==='chequing-a').atlasRole='household-reserve'; }, false],
    ['configured reserve cannot relabel operating identity', i => { i.plan.savingsEarmarks.pools.push({accountId:'chequing-a',role:'purpose-reserve'}); i.accountMap.mappings.find(m=>m.canonical.id==='chequing-a').atlasRole='household-reserve'; }, false],
    ['posted window incomplete', i => { i.window.complete=false; }, false],
    ['posted window truncated', i => { i.window.truncated=true; }, false],
    ['posted window has more rows', i => { i.window.hasMore=true; }, false],
    ['first gap day missing', i => { i.window.startDate='2026-10-01'; }, false],
    ['last gap day missing', i => { i.window.endDate='2026-09-30'; }, false],
    ['pending coverage unknown', i => { i.pendingCoverage='unknown'; }, false],
    ['unresolved pending cash in gap', i => { i.transactions[0].pending=true; }, false],
    ['unmapped row still blocks gap proof', i => { i.transactions.push({date:'2026-09-30',amount:1,accountRole:'unmapped'}); }, false],
    ['untrusted cash amount still blocks gap proof', i => { i.transactions[0].amount='not-cents'; }, false],
    ['missing original date', i => { delete i.plan.opening.asOf; }, false],
    ['legacy generic cash retains mapping requirement', i => { i.plan.startingCash.breakdown=[{id:'invented-generic-cash',value:100}]; i.transactions=[]; i.accountMap.mappings.push({canonical:{collection:'cash',id:'invented-generic-cash'},atlasRole:'household-cash'}); }, true],
    ['legacy generic cash unmapped remains held', i => { i.plan.startingCash.breakdown=[{id:'invented-generic-cash',value:100}]; i.transactions=[]; }, false],
  ];
  for (const [label, edit, expected] of cases) {
    const i=fixture.input(); edit(i); const before=JSON.stringify(i);
    const earned=O.paydayGapCompleteFromEvidence(i);
    ok(earned===expected && JSON.stringify(i)===before, 'reserve gap boundary: '+label);
  }
  const i=fixture.input(), canonical={meta:{asOf:'2026-09-29'},plan:i.plan,debts:[]};
  const payload=fixture.payload(i), original=JSON.stringify({canonical,payload,map:i.accountMap});
  const result=Live.fromObservation({data:canonical,payload,accountMap:i.accountMap});
  const snap=result.data.plan.opening.paydaySnapshot;
  // Independent cents: dated operating70+30, posted credit20, posted debit7.
  const independent=70+30+20-7;
  ok(result.report.currentPeriodActuals.paydayGapComplete===true && snap
      && snap.periodStart==='2026-10-02' && snap.asOf==='2026-10-02'
      && snap.opening===independent && F.startingCashAmount(result.data.plan)===independent,
    'real observe-to-overlay path earns113 from complete operating evidence without adding reported reserve119');
  const options={...i.x.opts,weeklyVariable:0,debts:[],
    currentPeriodActuals:result.data.liveOverlay.currentPeriodActuals,
    observedCash:result.data.liveOverlay.observedCash,operatingPlan:result.data.liveOverlay.operatingPlan};
  const a=F.recommend(result.data.plan,i.asOf,options);
  const close=(advice,start)=>{
    const view=advice.savingsFunding.periodViews.find(v=>v.start===start);
    return F.savingsFundingPublication(advice.savingsFunding,{asOf:i.asOf,advice,periodId:view.id}).forecastClosing;
  };
  ok(a.savingsFunding.stock.amount===119 && a.savingsFunding.goalAllocation.status==='ready'
      && a.savingsFunding.period.status==='ready', 'reported reserve119 stays known while the legitimately earned bridge qualifies funding');
  // The native provider omits the optional packet currency summary, but every
  // posted row is verified CAD. Complete reconciliation qualifies Bills83;
  // other chequing30 remains outside its sweep. No historical share is needed.
  const nextBills=a.payPeriodViews.find(p=>p.start==='2026-10-16');
  ok(nextBills.opening===83 && nextBills.paydaySweep===1083,
    'fully reconciled native provider packet sweeps Bills83 plus receipt1000 and excludes other30');
  for (const [start, receipts] of [['2026-10-16',1000],['2026-10-30',2000]]) {
    const c=close(a,start);
    ok(c.status==='ready' && Number.isFinite(c.stock) && Number.isFinite(c.operatingCash)
        && c.stock+c.operatingCash===119+independent+receipts
        && c.items.reduce((sum,row)=>sum+row.forecastSaved,0)+c.unallocated===c.stock
        && c.actualSaved===null && c.actionPermission==='not-granted' && c.moneyMovementPermission==='not-granted',
      'earned snapshot restores conserved hypothetical future Savings at '+start);
  }
  const absent=fixture.clone(result.data.plan); delete absent.opening.paydaySnapshot;
  const absentAdvice=F.recommend(absent,i.asOf,options), absentClose=close(absentAdvice,'2026-10-16');
  ok(absentClose.status==='unavailable' && absentClose.stock===null
      && absentClose.reason==='No original payday cash observation supports the cycle bridge.',
    'missing original evidence still withholds future Savings; no from-today bypass');
  const conflict=fixture.clone(result.data.plan);
  conflict.opening.paydaySnapshot={periodStart:'2026-10-02',asOf:'2026-10-02',opening:independent+1};
  const conflictClose=close(F.recommend(conflict,i.asOf,options),'2026-10-16');
  ok(conflictClose.status==='unavailable' && conflictClose.stock===null
      && conflictClose.reason==='The original payday opening and posted operating legs do not reconcile to current cash.',
    'contradictory original cash still withholds future Savings');
  ok(JSON.stringify({canonical,payload,map:i.accountMap})===original
      && result.data.liveOverlay.writesCanonicalState===false,
    'synthetic source pipeline preserves inputs and has no canonical write permission');
  for (const id of ['chequing-a','chequing-b']) {
    const duplicate=fixture.input();
    duplicate.plan.startingCash.breakdown.push(fixture.clone(duplicate.plan.startingCash.breakdown.find(r=>r.id===id)));
    const duplicateOriginal=JSON.stringify(duplicate);
    const duplicateResult=Live.fromObservation({data:{meta:{asOf:'2026-09-29'},plan:duplicate.plan,debts:[]},
      payload:fixture.payload(duplicate),accountMap:duplicate.accountMap});
    const duplicateOptions={...options,currentPeriodActuals:duplicateResult.data.liveOverlay.currentPeriodActuals,
      observedCash:duplicateResult.data.liveOverlay.observedCash,operatingPlan:duplicateResult.data.liveOverlay.operatingPlan};
    const duplicateAdvice=F.recommend(duplicateResult.data.plan,duplicate.asOf,duplicateOptions);
    ok(!duplicateResult.data.plan.opening.paydaySnapshot
        && duplicateAdvice.savingsFunding.period.status==='unavailable'
        && JSON.stringify(duplicate)===duplicateOriginal,
      'duplicate original '+id+' cannot publish a reconstructed payday opening or known current funding');
    duplicate.plan.opening.paydaySnapshot={periodStart:'2026-10-02',asOf:'2026-10-02',opening:independent};
    const duplicateFrozen=Live.fromObservation({data:{meta:{asOf:'2026-09-29'},plan:duplicate.plan,debts:[]},
      payload:fixture.payload(duplicate),accountMap:duplicate.accountMap});
    ok(duplicateFrozen.data.plan.opening.paydaySnapshot?.opening===independent,
      'valid recorded snapshot remains frozen despite duplicate original '+id+' reconstruction rows');
  }
  for (const [label,value] of [['null',null],['missing',undefined],['blank',''],['whitespace',' '],
    ['boolean',false],['NaN',NaN],['object',{}],['array',[]],['invalid string','not-cash']]) {
    const invalid=fixture.input();invalid.plan.startingCash.breakdown.find(r=>r.id==='chequing-a').value=value;
    const held=Live.fromObservation({data:{meta:{asOf:'2026-09-29'},plan:invalid.plan,debts:[]},
      payload:fixture.payload(invalid),accountMap:invalid.accountMap});
    ok(!held.data.plan.opening.paydaySnapshot,
      'original '+label+' cash stays unknown despite a complete ledger and reported live cash');
  }
  const unknown=fixture.input();unknown.plan.startingCash.breakdown[0].unknown=true;
  const unknownResult=Live.fromObservation({data:{meta:{asOf:'2026-09-29'},plan:unknown.plan,debts:[]},
    payload:fixture.payload(unknown),accountMap:unknown.accountMap});
  ok(!unknownResult.data.plan.opening.paydaySnapshot,'explicitly unknown original cash cannot earn an inferred zero');
  const legacyUnknown=fixture.input();delete legacyUnknown.plan.savingsEarmarks;delete legacyUnknown.plan.savingsPoolObservation;
  legacyUnknown.plan.startingCash.breakdown[0].value=null;legacyUnknown.plan.startingCash.breakdown[1].value=20;
  legacyUnknown.accountMap.mappings.find(m=>m.canonical.id==='savings').atlasRole='household-cash';
  const legacyUnknownResult=Live.fromObservation({data:{meta:{asOf:'2026-09-29'},plan:legacyUnknown.plan,debts:[]},
    payload:fixture.payload(legacyUnknown),accountMap:legacyUnknown.accountMap});
  ok(!legacyUnknownResult.data.plan.opening.paydaySnapshot,
    'legacy complete cash map cannot turn missing A plus B20 into an original opening33');
  const numeric=fixture.input();numeric.plan.startingCash.breakdown[0].value='70';
  const numericResult=Live.fromObservation({data:{meta:{asOf:'2026-09-29'},plan:numeric.plan,debts:[]},
    payload:fixture.payload(numeric),accountMap:numeric.accountMap});
  ok(numericResult.data.plan.opening.paydaySnapshot?.opening===independent,'known numeric original cash remains compatible');
  const zero=fixture.input();zero.plan.startingCash.breakdown.filter(r=>r.id.startsWith('chequing')).forEach(r=>{r.value=0;});
  const zeroPayload=fixture.payload(zero);zeroPayload.accounts[0].balance=13;zeroPayload.accounts[1].balance=0;
  const zeroResult=Live.fromObservation({data:{meta:{asOf:'2026-09-29'},plan:zero.plan,debts:[]},payload:zeroPayload,accountMap:zero.accountMap});
  ok(zeroResult.data.plan.opening.paydaySnapshot?.opening===0+20-7,'explicit known zero plus complete movements remains a known opening');
  const frozen=fixture.input();frozen.plan.startingCash.breakdown[0].value=null;
  frozen.plan.opening.paydaySnapshot={periodStart:'2026-10-02',asOf:'2026-10-02',opening:independent};
  const frozenResult=Live.fromObservation({data:{meta:{asOf:'2026-09-29'},plan:frozen.plan,debts:[]},
    payload:fixture.payload(frozen),accountMap:frozen.accountMap});
  ok(frozenResult.data.plan.opening.paydaySnapshot?.opening===independent,'a valid recorded payday snapshot remains usable without a new original-cash reconstruction');
}

if (failures) {
  console.log(`\nFAILED ${failures}`);
  process.exit(1);
}
console.log('\nOK');
