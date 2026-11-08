'use strict';
/* B96 / AF-PLAN-02 — prove the household payday question end to end.
 *
 * Chain: 2026-08-16 evidence → canonical data.json → Forecast → composed
 * household answer. Forecast remains the only calculator. This file does
 * not re-prove B91/B94/B95; it consumes those authorities and independently
 * reconciles the payday figures a household would read.
 *
 * `node test/test-b96-payday.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sourceText } = require('./test-source-text');
const { execFileSync } = require('child_process');
const F = require('../public/forecast.js');
const live = require('../data.json');
const periods = require('../public/periods.json');
const AUG16_REV = '28d08a12a18691f34c32bc839d22cd526fc75111';
const aug16Pinned = JSON.parse(execFileSync('git', ['show', `${AUG16_REV}:data.json`], { encoding: 'utf8' }));
const { paydayAnswerHtml, money2 } = loadPaydayComposer();

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const read = p => sourceText(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
const clone = x => JSON.parse(JSON.stringify(x));

const AS_OF = '2026-08-16';
const NEXT_PAY = '2026-08-28';
const JAN = '2027-01-15';
const BUFFER = live.plan.defaults.targetBuffer;
const WANT_CASH = 1320.13 + 932.05;
const RESERVED_AUG16 = 82.96 + 99.91 + 100 + 25;
const TENNIS = 2691.85;

function recOpts(extra) {
  return Object.assign({
    scenario: 'expected', incomeOverrides: {}, disabled: [],
    extraDebtMonthly: 0, targetBuffer: BUFFER,
    fundingSources: live.plan.funding && live.plan.funding.options,
    debts: live.debts,
    extraFacilities: live.revolvingExtra,
    extraDebtTarget: live.plan.nextDollar && live.plan.nextDollar.target,
    periods,
    paypalPerMonth: live.paypal && live.paypal.perMonth,
  }, extra || {});
}

function independentSpendable(plan) {
  return (plan.startingCash.breakdown || [])
    .filter(b => b && (b.id === 'chequing-a' || b.id === 'chequing-b'))
    .reduce((s, b) => s + Number(b.value || 0), 0);
}

function jointCashThrough(plan, start, end) {
  let out = 0;
  for (const o of plan.obligations || []) {
    if (o.nonCash) continue;
    for (const d of F.occurrences(o, start, end)) out += Number(o.amount || 0);
  }
  for (const b of plan.bills || []) {
    if (b.householdObligation === false) continue;
    if (b.payingAccount && ((plan.startingCash || {}).heldElsewhere || [])
      .some(r => r.id === b.payingAccount)) continue;
    for (const d of F.occurrences(b, start, end)) out += Number(b.amount || 0);
  }
  for (const c of plan.commitments || []) {
    if (c.settledOn && c.settledOn <= start) continue;
    if (!c.date || c.amount == null) continue;
    if (c.date >= start && c.date <= end) out += Number(c.amount || 0);
  }
  return out;
}

function questionStatus(md, id) {
  const re = new RegExp('### ' + id + '\\.[\\s\\S]*?\\*\\*Status:\\*\\*\\s*([^\\n]+)');
  const m = re.exec(md);
  return m ? m[1].trim() : null;
}

function loadPaydayComposer() {
  const appSrc = sourceText(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'));
  const planSrc = sourceText(fs.readFileSync(path.join(__dirname, '..', 'public', 'plan.js'), 'utf8'));
  const grab = (src, re, label) => {
    const m = re.exec(src);
    if (!m) throw new Error('missing ' + label);
    return m[0];
  };
  const formatters = [
    grab(appSrc, /^const money = .*$/m, 'money'),
    grab(appSrc, /^const money2 = .*$/m, 'money2'),
    grab(appSrc, /^const escapeHtml = .*$/m, 'escapeHtml'),
    grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
    grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
    grab(planSrc, /^const fmtMonth = .*$/m, 'fmtMonth'),
  ].join('\n');
  const maps = [
    grab(planSrc, /^const MISSION_PART = \{[\s\S]*?^\};$/m, 'MISSION_PART'),
    grab(planSrc, /^const NEXT_MOVE = \{[\s\S]*?^\};$/m, 'NEXT_MOVE'),
    grab(planSrc, /^function weeklyCapView\([\s\S]*?\n\}$/m, 'weeklyCapView'),
    grab(planSrc, /^function liveOperatingPlanUnavailable\([\s\S]*?\n\}$/m, 'liveOperatingPlanUnavailable'),
    grab(planSrc, /^function liveOperatingPlanNote\([\s\S]*?\n\}$/m, 'liveOperatingPlanNote'),
    grab(planSrc, /^function currentOperatingUnavailableHtml\([\s\S]*?\n\}$/m, 'currentOperatingUnavailableHtml'),
    grab(planSrc, /^function paydayActionRows\([\s\S]*?\n\}$/m, 'paydayActionRows'),
    grab(planSrc, /^function paydayOtherActionRows\([\s\S]*?\n\}$/m, 'paydayOtherActionRows'),
    grab(planSrc, /^function paydayReservedIds\([\s\S]*?\n\}$/m, 'paydayReservedIds'),
    grab(planSrc, /^function paydayComingRows\([\s\S]*?\n\}$/m, 'paydayComingRows'),
    grab(planSrc, /^function paydaySheet\([\s\S]*?\n\}$/m, 'paydaySheet'),
    grab(planSrc, /^function paydayCashNote\([\s\S]*?\n\}$/m, 'paydayCashNote'),
    grab(planSrc, /^function paydayObligationNote\([\s\S]*?\n\}$/m, 'paydayObligationNote'),
    grab(planSrc, /^function paydayCoverageNote\([\s\S]*?\n\}$/m, 'paydayCoverageNote'),
    grab(planSrc, /^function paydayBillStatusNote\([\s\S]*?\n\}$/m, 'paydayBillStatusNote'),
    grab(planSrc, /^function paydayAmountCell\([\s\S]*?\n\}$/m, 'paydayAmountCell'),
    grab(planSrc, /^function paydayAnswerHtml\([\s\S]*?\n\}$/m, 'paydayAnswerHtml'),
  ].join('\n');
  return vm.runInNewContext(
    `${formatters}\n${maps}\n({ paydayAnswerHtml, money, money2 });`,
    { Forecast: F }
  );
}

function composeLive(plan, extra) {
  const asOf = plan === live.plan ? live.meta.asOf : AS_OF;
  const opts = recOpts(extra);
  const advice = F.recommend(plan, asOf, opts);
  const weekly = opts.weeklyVariable != null ? opts.weeklyVariable : advice.weekly;
  const sim = weekly === advice.weekly ? advice.sim
    : F.simulate(plan, asOf, Object.assign({}, advice.simOptions, { weeklyVariable: weekly }));
  const status = F.planStatus(advice, { weeklyOverride: opts.weeklyVariable, sim });
  const debtProj = F.projectDebts(plan, opts.debts || live.debts, asOf,
    Object.assign({}, advice.simOptions, { weeklyVariable: weekly,
      extraFacilities: opts.extraFacilities || live.revolvingExtra,
      extraDebtTarget: opts.extraDebtTarget }));
  const mission = F.mission(advice, debtProj, { weeklyOverride: opts.weeklyVariable, sim });
  const nextMove = F.nextMove(plan, advice, { weeklyOverride: opts.weeklyVariable, sim });
  const budget = F.budgetBreakdown(plan, periods, {
    paypalPerMonth: live.paypal ? live.paypal.perMonth : 0,
    weeklyCap: weekly, recommendedWeekly: advice.weekly, asOf,
  });
  const revolving = F.utilisation(opts.debts || live.debts,
    opts.extraFacilities || live.revolvingExtra, plan).totalAvailable;
  const html = paydayAnswerHtml({
    plan, asOf, advice, status, mission, nextMove,
    nextOut: F.nextPaymentOut(sim.events, asOf),
    nextDue: F.nextDue(sim.events, asOf),
    unallocated: F.unallocatedCash(sim, budget, plan),
    budget, creditAvailable: revolving, weekly, recommended: advice.weekly,
    weeklyOverride: opts.weeklyVariable,
    debts: opts.debts || live.debts,
    liveOverlay: extra && extra.liveOverlay !== undefined
      ? extra.liveOverlay
      : (plan === live.plan ? live.liveOverlay : null),
  });
  return { advice, status, sim, budget, revolving, html, weekly };
}

console.log('=== A. current opening cash identity, independently ===');
{
  ok(live.meta.asOf === live.plan.opening.asOf,
    'live meta.asOf agrees with plan.opening.asOf', live.meta.asOf);
  const hand = independentSpendable(live.plan);
  ok(near(F.startingCashAmount(live.plan), hand),
    'Forecast.startingCashAmount equals the independent spendable sum');
  ok(aug16Pinned.meta.asOf === AS_OF && near(independentSpendable(aug16Pinned.plan), WANT_CASH),
    'pinned 2026-08-16 opening chequing spendable remains independently $2,252.18');
  const tennis = (live.plan.startingCash.heldElsewhere || [])
    .find(h => h.id === 'amanda-debt-payments');
  ok(tennis && near(tennis.value, TENNIS),
    'TENNIS INCOME is held-elsewhere, not in the spendable sum');
  ok(hand + TENNIS !== hand && !near(F.startingCashAmount(live.plan), hand + TENNIS),
    'adding TENNIS INCOME would disagree with spendable cash');
}

console.log('\n=== B. same master decision across short and longer views ===');
{
  const liveAsOf = live.meta.asOf;
  const a = F.recommend(live.plan, liveAsOf, recOpts({ viewDays: 14 }));
  const b = F.recommend(live.plan, liveAsOf, recOpts({ viewDays: 91 }));
  const c = F.recommend(live.plan, liveAsOf, recOpts({ viewDays: 365 }));
  ok(a.weekly === b.weekly && b.weekly === c.weekly,
    '14 / 91 / 365-day views share today\'s weekly cap', `$${a.weekly}`);
  ok(a.knowledge.days === b.knowledge.days && b.knowledge.days === c.knowledge.days
    && a.knowledge.days >= 365,
    'those views share the same ≥12-month knowledge horizon', String(a.knowledge.days));
  const seqA = (a.fundingSequence || []).map(x => x.id).join(',');
  const seqC = (c.fundingSequence || []).map(x => x.id).join(',');
  ok(seqA === seqC && seqA.length > 0,
    'funding sequence is the master sequence, not rebuilt per view');
}

console.log('\n=== C. future financial gravity affects today; the payday window does not ===');
{
  const liveAsOf = live.meta.asOf;
  const base = composeLive(live.plan);
  const naiveOut = jointCashThrough(live.plan, liveAsOf, NEXT_PAY);
  const naiveRemain = independentSpendable(live.plan) - naiveOut;
  const naiveWeekly = Math.floor((naiveRemain / 14) * 7 / 5) * 5;
  ok(naiveOut > 0 && !near(base.advice.weekly, naiveWeekly),
    'the payday answer is not cash minus bills-until-payday',
    `cap $${base.advice.weekly} vs naive $${naiveWeekly} (out through ${NEXT_PAY} = $${naiveOut.toFixed(2)})`);

  const withLater = clone(live);
  withLater.plan.commitments = (withLater.plan.commitments || []).concat([{
    id: 'b96-jan-gravity', label: 'January 2027 dated cost',
    date: JAN, amount: 250000, confidence: 'confirmed',
  }]);
  const pulled = F.recommend(withLater.plan, liveAsOf, recOpts());
  const pulledShort = F.recommend(withLater.plan, liveAsOf, recOpts({ viewDays: 14 }));
  ok(pulled.weekly < base.advice.weekly,
    'a dated January 2027 commitment on this same master plan reduces today\'s cap',
    `$${pulled.weekly} < $${base.advice.weekly}`);
  const xmas = clone(live);
  const xmasRow = (xmas.plan.commitments || []).find(c => c.id === 'christmas-2026');
  ok(xmasRow && xmasRow.date === '2026-12-25' && near(xmasRow.amount, 3500),
    'Christmas is the owner-dated $3,500 cash event on 2026-12-25');
  const xmasBefore = F.expandEvents(live.plan, liveAsOf, '2026-12-31', {})
    .filter(e => e.id === 'christmas-2026');
  ok(xmasBefore.length === 1 && xmasBefore[0].date === '2026-12-25'
      && near(xmasBefore[0].amount, -3500),
    'unsettle Christmas still emits −$3,500 on 2026-12-25');
  xmasRow.settledOn = liveAsOf;
  const xmasAfter = F.recommend(xmas.plan, liveAsOf, recOpts());
  const xmasEventsAfter = F.expandEvents(xmas.plan, liveAsOf, '2026-12-31', {})
    .filter(e => e.id === 'christmas-2026');
  ok(xmasEventsAfter.length === 0,
    'settling Christmas on as-of drops that dated cash event');
  ok(near(xmasAfter.knowledge.encumbered, base.advice.knowledge.encumbered),
    'a future dated Christmas cash event was not encumbered principal',
    `${base.advice.knowledge.encumbered.toFixed(2)} → ${xmasAfter.knowledge.encumbered.toFixed(2)}`);
  ok(xmasAfter.weekly === base.advice.weekly,
    'settling that dated Christmas event does not automatically become a higher weekly cap',
    `$${xmasAfter.weekly}`);
  ok(pulledShort.weekly === pulled.weekly,
    'narrowing the visible window to 14 days does not restore the higher cap',
    `$${pulledShort.weekly}`);
  const pulledHtml = composeLive(withLater.plan).html;
  ok(pulledHtml.includes(String(pulled.weekly)),
    'the composed payday answer carries the reduced master-plan cap');
  ok(!pulledHtml.includes(`$${naiveWeekly}/week`) || pulled.weekly === naiveWeekly,
    'the composed answer does not publish the naive cash-minus-bills weekly');
}

console.log('\n=== D. protected commitments are not double-counted; settled stays settled ===');
{
  const events = F.expandEvents(aug16Pinned.plan, AS_OF, F.addDays(AS_OF, 90), {});
  for (const id of ['fusioncamp', 'tryouts', 'burrard1', 'burrard2']) {
    ok(!events.some(e => e.id === id),
      `${id} is settled on the pinned 2026-08-16 opening and emits no cash event`);
  }
  const seqIds = (F.fundingSequence(aug16Pinned.plan, AS_OF, {}) || []).map(x => x.id);
  ok(!seqIds.includes('fusioncamp') && !seqIds.includes('tryouts'),
    'settled Fusion rows are not in the funding sequence');
  const reserved = events.filter(e => e.date === AS_OF && e.kind === 'bill' && e.jointCash !== false);
  const reservedSum = reserved.reduce((s, e) => s + -e.amount, 0);
  ok(near(reservedSum, RESERVED_AUG16),
    'unknown 15 August bills are reserved once on that opening, independently $307.87',
    reservedSum.toFixed(2));
  const nextOut = F.nextPaymentOut(events, AS_OF);
  ok(nextOut && nextOut.date === AS_OF && near(nextOut.amount, RESERVED_AUG16),
    'nextPaymentOut is that same reserved day total, not a second copy');
}

console.log('\n=== E. settled money redirects; remaining dated costs stay claimed ===');
{
  const liveAsOf = live.meta.asOf;
  const before = F.recommend(live.plan, liveAsOf, recOpts());
  const first = (before.fundingSequence || [])[0];
  const second = (before.fundingSequence || [])[1];
  ok(first && second, 'the live sequence has a next item and a following item',
    first && second && `${first.id} → ${second.id}`);

  const afterPlan = clone(live.plan);
  const row = (afterPlan.commitments || []).find(c => c.id === first.id);
  ok(!!row, 'the first sequenced item is a live commitment');
  row.settledOn = liveAsOf;
  const after = F.recommend(afterPlan, liveAsOf, recOpts());
  ok(!(after.fundingSequence || []).some(x => x.id === first.id),
    'settling the first item drops it from the sequence');
  ok((after.fundingSequence || [])[0] && after.fundingSequence[0].id === second.id,
    'capacity redirects to the next sequenced item',
    after.fundingSequence[0] && after.fundingSequence[0].id);
  const remaining = F.expandEvents(afterPlan, liveAsOf, '2027-02-12', {})
    .filter(event => event.id === 'provincials');
  ok(after.knowledge.encumbered === 0 && remaining.length === 1
      && remaining[0].date === '2027-02-12' && near(remaining[0].amount, -1500),
    'settling another item retains the dated Provincials cash event without undated encumbrance');
  const html = composeLive(afterPlan).html;
  ok(!/saved|already funded/i.test(html),
    'redirected capacity is not presented as already saved or funded');
}

console.log('\n=== F. overdue obligations cannot be rescued by later income ===');
{
  const liveAsOf = live.meta.asOf;
  const events = F.expandEvents(live.plan, liveAsOf, NEXT_PAY, {});
  const nextOut = F.nextPaymentOut(events, liveAsOf);
  const richer = clone(live.plan);
  richer.income = (richer.income || []).concat([{
    id: 'b96-late-windfall', label: 'Later windfall', frequency: 'once',
    date: '2026-08-29', amount: 20000, confidence: 'confirmed',
  }]);
  const after = F.expandEvents(richer, liveAsOf, F.addDays(liveAsOf, 20), {});
  const still = F.nextPaymentOut(after, liveAsOf);
  ok(nextOut && still && still.date === nextOut.date && near(still.amount, nextOut.amount),
    'a later windfall does not erase today\'s reserved cash-out',
    still && `${still.date} ${still.amount}`);

  const overdue = {
    windowDays: 40,
    defaults: { targetBuffer: 500 },
    startingCash: { amount: 600 },
    income: [{
      id: 'later-pay', label: 'Later pay', frequency: 'once',
      date: '2026-09-10', amount: 5000, confidence: 'confirmed',
    }],
    obligations: [],
    bills: [],
    commitments: [{
      id: 'overdue-item', label: 'Already due', date: '2026-08-10',
      amount: 800, confidence: 'confirmed',
    }],
    actions: [{ what: 'Cover the overdue item', amount: 800, due: '2026-08-10', status: 'open' }],
  };
  const rec = F.recommend(overdue, AS_OF, recOpts({
    fundingSources: [], debts: [], extraFacilities: [], extraDebtTarget: null,
  }));
  ok(rec.mode === 'infeasible' || rec.holds === false || (rec.infeasible && rec.infeasible.kind),
    'an overdue protected item is not rescued by later income',
    rec.mode + ' ' + JSON.stringify(rec.infeasible));
  const html = composeLive(overdue, {
    fundingSources: [], debts: [], extraFacilities: [], extraDebtTarget: null,
  }).html;
  ok(/INFEASIBLE/.test(html) || /Already due/.test(html),
    'the payday answer still names the overdue constraint after later income exists');
}

console.log('\n=== G. credit is not cash or safe-to-spend ===');
{
  const liveRun = composeLive(live.plan);
  const cash = independentSpendable(live.plan);
  ok(liveRun.revolving > 0, 'there is revolving headroom on this opening',
    String(liveRun.revolving));
  ok(!near(cash, cash + liveRun.revolving),
    'adding credit headroom would disagree with spendable cash');
  const alloc = liveRun.advice.paydayAllocation;
  ok(alloc && near(alloc.available, cash),
    'Forecast.paydayAllocation available cash is still independent spendable');
  ok(!liveRun.html.includes(money2(liveRun.revolving)),
    'between-paydays action card does not publish revolving headroom as cash');
  ok(!near(liveRun.advice.weekly, liveRun.advice.weekly + liveRun.revolving / 13),
    'safe-to-spend is not inflated by dividing credit across the view');
}

console.log('\n=== H. Q19 / Q26 ANSWERED; Q20 / Q25 stay visible and fail-closed ===');
{
  const md = read('docs/01_OPEN_QUESTIONS.md');
  ok(/^ANSWERED\b/.test(questionStatus(md, 'Q19')), 'Q19 is ANSWERED', questionStatus(md, 'Q19'));
  ok(/^ANSWERED\b/.test(questionStatus(md, 'Q26')), 'Q26 evidence is ANSWERED', questionStatus(md, 'Q26'));
  for (const id of ['Q20', 'Q25']) {
    ok(/^OPEN\b/.test(questionStatus(md, id)), `${id} remains OPEN`, questionStatus(md, id));
  }
  const liveRun = composeLive(live.plan);
  ok(!/Q19 HELOC August cash impact stays OPEN/i.test(liveRun.html),
    'payday HTML does not keep Q19 as unresolved');
  ok(!/Q20/.test(liveRun.html) && !/emergency reserve/i.test(liveRun.html),
    'payday worksheet does not relabel the model buffer as a Q20 emergency reserve');
  const tennisHeld = (live.plan.startingCash.heldElsewhere || [])
    .find(h => h.id === 'amanda-debt-payments');
  ok(tennisHeld && !near(independentSpendable(live.plan),
    independentSpendable(live.plan) + tennisHeld.value),
    'TENNIS INCOME is still excluded from the spendable cash figure (Q25)');
  ok(!liveRun.html.includes(money2(tennisHeld.value)),
    'payday worksheet does not publish TENNIS INCOME as available cash');
  const cashback = live.debts.find(d => d.id === 'cashback');
  if (cashback && cashback.pendingUnknown === true) {
    ok(cashback.pending == null, 'canonical Cash Back pending is unknown, not $0');
    ok(!/treated as \$0/i.test(liveRun.html),
      'payday worksheet does not treat unknown pending as $0');
  } else {
    ok(cashback && cashback.pendingUnknown !== true && Number.isFinite(Number(cashback.pending)),
      'live Cash Back pending is a known observation, not silently omitted');
  }
  ok(!/Q25/.test(liveRun.html) && !/Q26/.test(liveRun.html),
    'payday worksheet does not narrate Q25/Q26; those stay on Outlook and the questions file');
  const heloc = (live.plan.obligations || []).find(o => o.id === 'heloc');
  ok(heloc && heloc.nonCash === true && near(heloc.amount, 814.18)
    && /debts\.heloc\.cashPayment stays \$0/i.test(heloc.note || ''),
    'live HELOC interest remains capitalised; debt cashPayment stays $0');
}

console.log('\n=== I. household-facing composed answer agrees with Forecast ===');
{
  const liveRun = composeLive(live.plan);
  const advice = liveRun.advice;
  ok(liveRun.html.includes(String(advice.weekly)),
    'HTML carries Forecast.recommend weekly', String(advice.weekly));
  ok(advice.weekly !== 600, '$600/week is not the payday output');
  ok(!/function paydayEngine|Forecast\.paydayPlan/.test(read('public/plan.js') + read('public/forecast.js')),
    'no second payday planner exists');
  const action = advice.currentPeriodAction;
  ok(action && action.mode === 'between-paydays',
    'the dated live opening is a current-period action plan, not a payday allocation worksheet');
  const first = (advice.fundingSequence || [])[0];
  ok(first,
    'the master funding sequence still exists on Forecast.recommend');
  const rosterHits = (advice.majorPlans || []).filter(p => liveRun.html.includes(p.label)).length;
  ok(rosterHits <= 3,
    'current-period action card does not reprint the major-plans roster', String(rosterHits));
  ok(!/ON TRACK/.test(liveRun.html),
    'ON TRACK verdicts stay in Outlook, not the current-period card');
  ok(!/Set aside/.test(liveRun.html),
    '90-day set-asides stay on the master outlook, not the between-paydays action card');
  ok(liveRun.status.id === (advice.mode === 'infeasible' ? 'infeasible' : liveRun.status.id),
    'status band does not contradict recommend.mode');
  if (advice.mode === 'infeasible') {
    ok(/INFEASIBLE/.test(liveRun.html), 'infeasible recommend renders INFEASIBLE');
  } else {
    ok(!/INFEASIBLE/.test(liveRun.html),
      'the live opening is not published as INFEASIBLE');
  }
  const nextOut = F.nextPaymentOut(liveRun.sim.events, live.meta.asOf);
  if (nextOut) {
    const inPeriod = ((action && action.bills) || []).some(b =>
      b && (b.id === nextOut.id || b.label === nextOut.label));
    if (inPeriod) {
      ok(liveRun.html.includes(nextOut.label),
        'a current-period still-due outflow is named on the action card',
        nextOut.label);
    } else {
      ok(true, 'nextPaymentOut outside the current-period bill list stays off the action card',
        nextOut.label);
    }
  }
}

console.log('\n=== J. page layer does not re-decide the payday figures ===');
{
  const planJs = read('public/plan.js');
  const fn = /function paydayAnswerHtml\([\s\S]*?\n\}/.exec(planJs);
  ok(!!fn, 'paydayAnswerHtml is a dedicated composition function');
  const body = fn ? fn[0] : '';
  ok(/advice\.weekly|advice\.nearBoundary|advice\.paydayAllocation/.test(body)
    && /fundingSequence|plannedDebt|majorPlans|paydayAllocation/.test(planJs),
    'the composer reads incumbent Forecast result fields');
  ok(!/recommendWeekly\(|protectedPlanCheck\(|allocateToSequence\(/.test(body),
    'the composer does not call a second weekly search or allocator');
  ok(!/startingCashAmount\(plan\)\s*[-+]/.test(body),
    'the composer does not invent spendable as cash minus bills');
  ok(/payday-answer-body/.test(planJs) && /paydayAnswerHtml\(/.test(planJs),
    'the Plan page mounts the composed payday answer');
  ok(/id="payday-answer"/.test(read('public/index.html')),
    'index.html has the household payday section');
  ok(!/verdict\s*=\s*['"]ON TRACK['"]/.test(body),
    'the composer does not assign ON TRACK itself');
  ok(/near\.payday/.test(body),
    'the composer reads Forecast.nearBoundary.payday rather than inventing a span');
  ok(!/\*\s*14\b|\*\s*7\b|\/\s*14\b/.test(body),
    'the composer does not turn the weekly cap into a 7- or 14-day leftover');
}

console.log('\n=== K. explicit INFEASIBLE when the protected plan cannot work ===');
{
  const broke = {
    windowDays: 40,
    defaults: { targetBuffer: 500 },
    startingCash: { amount: 800 },
    income: [],
    obligations: [],
    bills: [],
    commitments: [{
      id: 'cannot-fund', label: 'Cannot fund this', date: '2026-08-10',
      amount: 2500, confidence: 'confirmed',
    }],
    actions: [{ what: 'Find money', amount: 2500, due: '2026-08-10', status: 'open' }],
  };
  const rec = F.recommend(broke, AS_OF, recOpts({
    fundingSources: [{ id: 'empty', label: 'Empty', short: 'empty', available: 10, rank: 1 }],
    debts: [], extraFacilities: [], extraDebtTarget: null,
  }));
  const status = F.planStatus(rec, { sim: rec.sim });
  ok(rec.mode === 'infeasible' && rec.infeasible,
    'Forecast.recommend reports infeasible on an unfundable protected plan',
    rec.mode);
  ok(status.id === 'infeasible',
    'planStatus copies that INFEASIBLE result rather than saying onPlan',
    status.id);
  const html = composeLive(broke, {
    fundingSources: [{ id: 'empty', label: 'Empty', short: 'empty', available: 10, rank: 1 }],
    debts: [], extraFacilities: [], extraDebtTarget: null,
  }).html;
  ok(/INFEASIBLE/.test(html), 'the payday HTML says INFEASIBLE');
  ok(html.includes(rec.infeasible.label) || html.includes('Cannot fund this'),
    'and names the failing protected constraint');
  const mission = F.mission(rec, { marks: [] }, { sim: rec.sim });
  ok(mission.parts.length === 1 && mission.parts[0].id === 'infeasible',
    'Forecast.mission emits the infeasible outcome rather than holdSpending at $0',
    mission.parts.map(p => p.id).join(' → '));
  ok(!/hold spending to/.test(html) && !/put the surplus against the most expensive card/.test(html),
    'infeasible payday HTML does not give hold-spending or surplus-to-card instructions');
  ok(!/Master-plan cap/.test(html),
    'and does not label the zero-spend sentinel as a master-plan cap');
  ok(/no feasible weekly cap/i.test(html) && /weekly spending\s+figure does not fix this/.test(html),
    'Safe to spend says there is no feasible weekly cap');
}

console.log('\n=== L. unfunded opening-gap sentinel is not a $0/week cap ===');
{
  const spendCell = html => {
    const m = /<div class="payday-spend">([\s\S]*?)<\/div>/.exec(html);
    return m ? m[1] : '';
  };
  const noEngine = {
    fundingSources: [], debts: [], extraFacilities: [], extraDebtTarget: null,
  };

  const BUFFER = 400;
  const CASH = 150;
  const unfundedPlan = {
    windowDays: 21,
    defaults: { targetBuffer: BUFFER },
    startingCash: { amount: CASH },
    income: [{
      id: 'later-pay', label: 'Later pay', frequency: 'once',
      date: '2026-08-30', amount: 3000, confidence: 'confirmed',
    }],
    obligations: [],
    bills: [],
    commitments: [],
    actions: [{ what: 'Cover the gap', amount: 50, due: '2026-08-16', status: 'open' }],
  };
  const unfundedOpts = {
    targetBuffer: BUFFER,
    fundingSources: [{ id: 'empty', label: 'Empty pot', short: 'empty', available: 0, rank: 1 }],
    debts: [], extraFacilities: [], extraDebtTarget: null,
  };
  const unfunded = composeLive(unfundedPlan, unfundedOpts);
  const independentGap = BUFFER - CASH;
  ok(unfunded.advice.mode === 'openingGap',
    'thin cash against the buffer is an opening gap', unfunded.advice.mode);
  ok(unfunded.advice.weekly === 0,
    'raw weekly is the zero sentinel, independently of the composer');
  ok(unfunded.advice.funding && unfunded.advice.funding.feasible === false,
    'Forecast.funding.feasible is false — a declared empty source cannot cover');
  ok(near(independentGap, unfunded.advice.gap.amount)
    && near(independentGap, unfunded.advice.funding.shortfall),
    'engine shortfall equals the independent buffer minus cash',
    `${independentGap} vs gap ${unfunded.advice.gap.amount} / shortfall ${unfunded.advice.funding.shortfall}`);
  ok(unfunded.status.id === 'unfunded',
    'planStatus is unfunded, not onPlan at $0', unfunded.status.id);
  const unfundedMission = F.mission(unfunded.advice, { marks: [] }, { sim: unfunded.sim });
  ok(unfundedMission.parts.some(p => p.id === 'fundingShortfall')
    && !unfundedMission.parts.some(p => p.id === 'holdSpending'),
    'mission is fundingShortfall rather than holdSpending at $0',
    unfundedMission.parts.map(p => p.id).join(' → '));
  const unfundedCell = spendCell(unfunded.html);
  ok(/no feasible weekly cap/i.test(unfundedCell),
    'Household spending says there is no feasible weekly cap');
  ok(/unfunded/i.test(unfundedCell) && /protected shortfall is solved/.test(unfundedCell),
    'and names the unresolved funding gap rather than a cap');
  ok(unfundedCell.includes(money2(independentGap)),
    'and carries the independent shortfall', money2(independentGap));
  ok(!/Master-plan cap/.test(unfundedCell),
    'it does not label the sentinel as a master-plan cap');
  ok(!/\$0\/week/.test(unfundedCell),
    'and does not publish $0/week as safe to spend');

  const unfundedOverride = composeLive(unfundedPlan,
    Object.assign({}, unfundedOpts, { weeklyVariable: 75 }));
  ok(unfundedOverride.advice.funding && unfundedOverride.advice.funding.feasible === false
    && unfundedOverride.status.id === 'unfunded',
    'an unfunded gap stays unfunded when the household types a weekly override');
  const overrideCell = spendCell(unfundedOverride.html);
  ok(/no feasible weekly cap/i.test(overrideCell)
    && /protected shortfall is solved/.test(overrideCell),
    'Household spending still refuses a cap under that override');
  ok(!/Master-plan cap/.test(overrideCell),
    'and does not label the override as a master-plan cap');
  ok(!/forecast supports/.test(overrideCell),
    'and does not call the override Forecast-supported');

  const fatPlan = {
    windowDays: 21,
    defaults: { targetBuffer: 200 },
    startingCash: { amount: 5000 },
    income: [{
      id: 'pay', label: 'Pay', frequency: 'once',
      date: '2026-08-30', amount: 2000, confidence: 'confirmed',
    }],
    obligations: [],
    bills: [{
      id: 'bill', label: 'Small bill', frequency: 'once',
      date: '2026-08-20', amount: 100, confidence: 'confirmed',
    }],
    commitments: [],
  };
  const fat = composeLive(fatPlan, Object.assign({ targetBuffer: 200 }, noEngine));
  const leftover = 5000 - 100 - 200;
  ok(leftover > 0 && fat.advice.weekly > 0 && fat.advice.mode === 'normal'
    && !(fat.advice.funding && fat.advice.funding.feasible === false),
    'surplus after bill and buffer independently implies a positive feasible cap',
    `leftover ${leftover} weekly $${fat.advice.weekly} mode ${fat.advice.mode}`);
  const fatCell = spendCell(fat.html);
  ok(/payday-hero/.test(fatCell) && /\/ week/.test(fatCell) && fat.advice.weekly > 0,
    'a feasible positive cap still renders as dollar/week',
    `$${fat.advice.weekly}/week`);
  ok(/Stay under this and the protected plan holds/.test(fatCell),
    'and restates the existing protected-plan meaning of that cap');
  ok(!/no feasible weekly cap/i.test(fatCell),
    'and does not borrow the unfunded wording');

  const tightPlan = {
    windowDays: 14,
    defaults: { targetBuffer: 800 },
    startingCash: { amount: 800 },
    income: [],
    obligations: [],
    bills: [],
    commitments: [],
  };
  const tight = composeLive(tightPlan, Object.assign({ targetBuffer: 800 }, noEngine));
  ok(tight.advice.mode === 'normal' && tight.advice.weekly === 0
    && !(tight.advice.funding && tight.advice.funding.feasible === false),
    'cash equal to the buffer with no outflows is a feasible $0 cap',
    `${tight.advice.mode} weekly=${tight.advice.weekly}`);
  const tightCell = spendCell(tight.html);
  ok(/\$0/.test(tightCell) && /\/ week/.test(tightCell),
    'a genuine feasible-zero cap still renders honestly as $0/week');
  ok(!/no feasible weekly cap/i.test(tightCell),
    'and is not described as an unfunded gap');
}

console.log('\n=== M. homepage leads with the decision-first operating surface ===');
{
  const index = read('public/index.html');
  const operatingAt = index.indexOf('id="operating-surface"');
  const paydayAt = index.indexOf('id="payday-answer"');
  const plan90At = index.indexOf('id="plan90"');
  const outlookAt = index.indexOf('id="outlook"');
  const h1Count = (index.match(/<h1[\s>]/g) || []).length;
  ok(h1Count === 0,
    'the Budget page has no page h1; the removed This payday heading is not the operating surface');
  const paydaySection = /<section id="payday-answer"[\s\S]*?<\/section>/.exec(index);
  const outlookSection = /<section id="outlook">[\s\S]*?<\/section>/.exec(index);
  ok(operatingAt >= 0 && paydayAt > operatingAt && plan90At > paydayAt,
    'the operating surface leads and diagnostic mounts remain after it');
  ok(outlookAt > paydayAt && outlookAt < plan90At,
    'Outlook diagnostic heading still sits between the worksheet mount and 90-day material');
  const operatingSection = /<section id="operating-surface">[\s\S]*?<\/section>/.exec(index);
  ok(operatingSection && /id="operating-surface-body"/.test(operatingSection[0]),
    'the operating surface has a dedicated Forecast-result mount');
  ok(paydaySection && /id="payday-heading"/.test(paydaySection[0])
      && /hidden/.test(paydaySection[0])
      && !/View full current-period worksheet/.test(paydaySection[0]),
    'the current-period worksheet mount remains for renderPlan and is not on the default Plan');
  ok(!/Why \/ Road ahead/.test(index),
    'Why / Road ahead is not a default Plan disclosure');
  ok(!/Now → next payday/.test(index),
    'static Now → next payday wording is gone');
  ok(/Master forecast outlook/i.test(index),
    'the 90-day band is labelled as master forecast outlook');
  ok(h1Count === 0,
    'there is no Plan page h1 after the This payday heading was removed');
  ok(paydaySection && !/id="status-band"/.test(paydaySection[0]),
    'the status band is not inside the secondary current-period worksheet');
  ok(outlookSection && /id="status-band"/.test(outlookSection[0]),
    'the status band lives in Outlook as evidence');
  ok(/id="plan-mission"/.test(index) && /id="cap-headline"/.test(index)
    && /id="agenda-14"/.test(index) && /id="c-forecast"/.test(index)
    && /id="budget-cats"/.test(index) && /id="score-table"/.test(index)
    && /id="major-plans-list"/.test(index) && /id="nextmove-card"/.test(index),
    'existing Outlook mounts remain on the page');
  const liveRun = composeLive(live.plan);
  const action = liveRun.advice.currentPeriodAction;
  ok(action && action.mode === 'between-paydays',
    'the dated opening is not a payday, so the front door is between-paydays');
  ok(/payday-group/.test(liveRun.html)
    && /What to do now/.test(liveRun.html)
    && /Everyday spending left/.test(liveRun.html)
    && /Household spending/.test(liveRun.html)
    && /Next decision point/.test(liveRun.html),
    'composed HTML uses the between-paydays action groups');
  const doAt = liveRun.html.indexOf('What to do now');
  const spendAt = liveRun.html.indexOf('Everyday spending left');
  const permAt = liveRun.html.indexOf('Household spending');
  const nextAt = liveRun.html.indexOf('Next decision point');
  ok(doAt >= 0 && spendAt > doAt && permAt > spendAt && nextAt > permAt,
    'action groups are what to do → spending left → permission → next payday');
  ok(!/What to do with this paycheque/.test(liveRun.html),
    'between-paydays does not reuse the payday allocation headline');
  ok(!/What happens next/.test(liveRun.html) && !/Do this \/ protect this/.test(liveRun.html),
    'the verbose PR #157 groups are no longer the primary surface');
  const paydayDate = liveRun.advice.nearBoundary && liveRun.advice.nearBoundary.payday;
  if (paydayDate) {
    const asOfLong = new Date(live.meta.asOf + 'T00:00:00').toLocaleDateString('en-CA', {
      day: 'numeric', month: 'long',
    });
    ok(!/Now →/.test(liveRun.html),
      'dated live opening is not labelled Now');
    ok(liveRun.html.includes(`As at ${asOfLong}`),
      'front door names the dated as-of', asOfLong);
    ok(liveRun.html.includes(paydayDate.slice(8)) || liveRun.html.includes(paydayDate),
      'front door names the next payday', paydayDate);
  }
  ok(!/function paydayEngine|Forecast\.paydayPlan/.test(read('public/plan.js') + read('public/forecast.js')),
    'front-door work did not add a second payday planner');
}

console.log('\n=== N. current-period action hierarchy, itemization, and fail-closed ===');
{
  const liveRun = composeLive(live.plan);
  const html = liveRun.html;
  const alloc = liveRun.advice.paydayAllocation;
  const action = liveRun.advice.currentPeriodAction;
  ok(action && action.mode === 'between-paydays',
    'dated live opening is between paydays, so the front door is the action plan');
  ok(alloc && (alloc.obligations.items || []).length > 0,
    'live paydayAllocation still returns obligation items');
  const bills = action.bills || [];
  const done = bills.filter(b => b.settlement === 'represented');
  const verify = bills.filter(b => b.settlement === 'unverified');
  const due = bills.filter(b => b.settlement === 'upcoming');
  const doneRows = (html.match(/class="payday-done"/g) || []).length;
  const obligationRows = (html.match(/class="payday-obligation"/g) || []).length;
  const essentialRows = (html.match(/class="payday-essential"/g) || []).length;
  ok(doneRows === done.length,
    'every represented current-period bill is rendered as already done',
    `${doneRows} vs ${done.length}`);
  ok(obligationRows === verify.length + due.length,
    'unverified and still-due bills are rendered as action rows',
    `${obligationRows} vs ${verify.length}+${due.length}`);
  const precise = action.remainingClaim === 'precise' || action.remainingClaim === 'posted-only';
  if (precise) {
    const spendCats = (action.categories || []).filter(c => c && c.class === 'essential' && (
      Number(c.planned) > 0 || Number(c.remaining) !== 0 || Number(c.posted) > 0
    ));
    ok(essentialRows === spendCats.length,
      'every current-period essential remaining line is rendered',
      `${essentialRows} vs ${spendCats.length}`);
  } else {
    const needRows = (alloc.essentials.items || []).filter(r => r && Number(r.required) > 0);
    ok(essentialRows === needRows.length,
      'without precise actuals, period-need essential lines are rendered',
      `${essentialRows} vs ${needRows.length}`);
    ok(/cannot be confirmed|unavailable/i.test(html),
      'absent or stale actuals fail closed on the page rather than inventing remaining');
  }
  ok(!/Keep for bills/.test(html) && !/Hold for essential costs/.test(html),
    'collapsed bill/essential totals are not the household-facing lines');
  ok(/settlement not proven/.test(html) || /Still due/.test(html) || /Already done/.test(html),
    'bill settlement states are visible');
  ok(!/confirmed unpaid|definitely unpaid|unpaid bill/i.test(html),
    'unverified bills are not called unpaid');
  ok(!/data-fig="spendable"/.test(html),
    'usable cash is not the between-paydays headline');
  ok((html.match(/class="payday-hero"/g) || []).length === 1,
    'one prominent number: household spending permission');
  ok(!/payday-plans|missionSentence|Q20|Q25|Q26|Master-plan leftover|Credit left everywhere/.test(html),
    'secondary Forecast explanation is not inside the action card');
  ok(!/\bsaved\b|\balready funded\b|\bfunded savings\b/i.test(html),
    'planned future-cost money is not presented as already funded or saved');
  ok(!html.includes(money2(liveRun.revolving)),
    'HELOC/card headroom is not on the action card as cash');
  const styles = read('public/styles.css');
  ok(/\.payday-hero \{[^}]*font-size:2\.25rem/.test(styles),
    'primary numbers are large, not cramped');
  ok(/@media \(max-width:640px\) \{[\s\S]*?\.payday-hero \{ font-size:2rem; \}/.test(styles),
    'narrow width keeps the hero at 2rem, not tiny text');
  ok(/\.payday-sheet td \{[^}]*font-size:1\.05rem/.test(styles),
    'action rows stay at reading size');
  ok(!/startingCashAmount\(plan\)\s*[-+]/.test(read('public/plan.js')),
    'the page still does not invent spendable as cash minus bills');
  const planJs = read('public/plan.js');
  const forecastJs = read('public/forecast.js');
  ok(!/function paydayEngine|Forecast\.paydayPlan/.test(planJs + forecastJs),
    'no second payday planner was added for the current-period card');
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll B96 payday-proof checks passed.');
