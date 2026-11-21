'use strict';
/* Focused proof for Forecast.planPhases(). The Plan page's three phase
 * titles, the opening-body selection, the 31–60 direction, the HELOC-in-phase
 * threshold, and which risks appear with which figures used to be decided in
 * public/plan.js. Flipping `day90.consumer < today.consumer` to `>` and
 * changing `transferMonthly * 3` to `* 2` left npm test green — ALL 21
 * SUITES PASSED — because no test could reach the page.
 *
 * Correctness cases are hand-computed from literal marks, amounts and
 * crossings — not the function that now produces the answer. Live titles
 * and figures are reconciled against the same comparisons the page used,
 * evaluated here from recommend / projectDebts results, not from planPhases.
 */
const fs = require('fs');
const vm = require('vm');
const { sourceText } = require('./test-source-text');
const F = require('../public/forecast.js');
const data = require('../data.json');
const periods = require('../public/periods.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const same = (a, b) => a === b;
const read = p => sourceText(fs.readFileSync(p, 'utf8'));
const titles = outlook => (outlook.phases || []).map(p => p.titleId).join(' → ');
const riskIds = outlook => (outlook.risks || []).map(r => r.id).join(', ');
const risk = (outlook, id) => (outlook.risks || []).find(r => r.id === id) || null;

const SIM = {
  ending: 4000, buffer: 500,
  daily: [{ date: '2026-09-07', balance: 1200 }],
  min: { balance: 600, date: '2026-08-20' },
};
const adviceOf = extra => Object.assign({
  weekly: 1000,
  sim: SIM,
  gap: { amount: 1043.16, date: '2026-08-12' },
  funding: { feasible: true, shortfall: 0, parts: [] },
}, extra || {});
const debtOf = opts => {
  const o = opts || {};
  const c0 = o.c0 != null ? o.c0 : 10000;
  const c60 = o.c60 != null ? o.c60 : 9000;
  const c90 = o.c90 != null ? o.c90 : 8000;
  const crossings = [];
  if (o.helocDay != null) {
    crossings.push({
      id: 'heloc', label: 'HELOC', alreadyOver: !!o.helocAlready,
      day: o.helocDay, date: '2026-09-30',
    });
  }
  for (const c of o.extraCrossings || []) crossings.push(c);
  return {
    marks: [
      { day: 0, date: '2026-08-09', consumer: c0, headroom: 500,
        debts: o.overToday
          ? [{ id: 'card', label: 'Card', overLimit: true }] : [] },
      { day: 30, date: '2026-09-07', consumer: c0, headroom: 500 },
      { day: 60, date: '2026-10-07', consumer: c60, headroom: 400 },
      { day: 90, date: '2026-11-06', consumer: c90, headroom: 300 },
    ],
    crossings,
  };
};
const PLAN = {
  startingCash: { amount: 2000 },
  commitments: [
    { id: 'est1', label: 'Fusion camp', amount: 786, confidence: 'estimated' },
    { id: 'ok1', label: 'Burrard', amount: 320, confidence: 'confirmed' },
  ],
  obligations: [{ id: 'heloc', amount: 814.18 }],
};
const run = (advice, debt, extraOpts) =>
  F.planPhases(PLAN, advice, debt, Object.assign({ sim: SIM }, extraOpts || {}));

console.log('=== phase titles: both sides of each comparison ===');
const withGap = run(adviceOf(), debtOf({ overToday: true, c90: 8000 }));
ok(withGap.phases[0].titleId === 'coverGap' && withGap.phases[0].id === 'coverGap',
  'a fundable gap titles 0–30 Cover the gap and uses the coverGap body');
ok(withGap.phases[1].titleId === 'overLimit',
  'a facility over today titles 31–60 Get back inside the limits');
ok(withGap.phases[2].titleId === 'surplusToPrincipal',
  'consumer 8000 < 10000 titles 61–90 Put the surplus against principal');

const noGap = run(adviceOf({ gap: null }), debtOf({ overToday: false, c90: 11000 }));
ok(noGap.phases[0].titleId === 'holdBuffer' && noGap.phases[0].id === 'holdBuffer',
  'no gap titles 0–30 Hold the buffer');
ok(noGap.phases[1].titleId === 'relievePressure',
  'nothing over today titles 31–60 Relieve revolving pressure');
ok(noGap.phases[2].titleId === 'stopGrowth',
  'consumer 11000 > 10000 titles 61–90 Stop the growth');

const unfunded = run(adviceOf({
  funding: { feasible: false, shortfall: 400, parts: [] },
}), debtOf());
ok(unfunded.phases[0].titleId === 'coverGap' && unfunded.phases[0].id === 'unfunded'
  && same(unfunded.phases[0].shortfall, 400)
  && same(unfunded.phases[0].gapAmount, 1043.16),
  'an unfunded gap keeps the Cover the gap title and selects the unfunded body',
  unfunded.phases[0].id);

console.log('\n=== equality / boundary on consumer direction and HELOC day ===');
const equal90 = run(adviceOf(), debtOf({ c90: 10000 }));
ok(equal90.phases[2].titleId === 'stopGrowth',
  'day90.consumer === today.consumer is Stop the growth — the page used `<`, so equality does not count as a fall');

const equal60 = run(adviceOf(), debtOf({ c60: 10000 }));
ok(equal60.phases[1].consumerDirection === 'up' && same(equal60.phases[1].consumerMove, 0),
  'day60.consumer === today.consumer is "up" by $0 — the page used `<` here too');

const justDown = run(adviceOf(), debtOf({ c90: 9999.99, c60: 9999.99 }));
ok(justDown.phases[2].titleId === 'surplusToPrincipal'
  && justDown.phases[1].consumerDirection === 'down',
  'one cent down is a fall on both comparisons');

const helocOn60 = run(adviceOf(), debtOf({ helocDay: 60 }), {
  alternatives: { gapFundingAlternatives: [] },
});
ok(helocOn60.phases[1].helocInPhase === true
  && helocOn60.phases[1].helocDate === '2026-09-30',
  'HELOC crossing on day 60 is inside 31–60 (`<= 60`)');

const helocOn61 = run(adviceOf(), debtOf({ helocDay: 61 }), {
  alternatives: { gapFundingAlternatives: [] },
});
ok(helocOn61.phases[1].helocInPhase === false && helocOn61.phases[1].helocDate === null,
  'HELOC crossing on day 61 is not named in the 31–60 body');

const alreadyOver = run(adviceOf(), debtOf({ helocDay: 10, helocAlready: true }));
ok(alreadyOver.phases[1].helocInPhase === false
  && !risk(alreadyOver, 'helocNoDraw') && !risk(alreadyOver, 'helocDrawn'),
  'a HELOC already over today is not a crossing risk — same helper as the mission');

console.log('\n=== cash at day 30 is the simulation balance on the mark date ===');
ok(same(withGap.phases[0].cashAt30, 1200) && withGap.phases[0].date30 === '2026-09-07',
  'cash at 30 is $1,200 on 2026-09-07, read off sim.daily, not re-derived');
ok(same(withGap.phases[0].weekly, 1000),
  'the weekly figure on the opening body is the one on screen');

console.log('\n=== risk selection: both sides, and the * 3 figure ===');
const HAND_TRANSFER = 2182;
const HAND_THREE_MONTH = HAND_TRANSFER * 3;
ok(HAND_THREE_MONTH === 6546, 'hand: $2,182 × 3 = $6,546');

const amandaNeed = run(adviceOf(), debtOf(), {
  transfer: { amount: HAND_TRANSFER, neededBy: '2026-08-23' },
});
ok(risk(amandaNeed, 'amandaRequired')
  && same(risk(amandaNeed, 'amandaRequired').windowImpact, HAND_THREE_MONTH)
  && risk(amandaNeed, 'amandaRequired').neededBy === '2026-08-23',
  'a needed-by date selects amandaRequired and publishes amount × 3');

const amandaHolds = run(adviceOf(), debtOf(), {
  transfer: { amount: HAND_TRANSFER, neededBy: null },
});
ok(risk(amandaHolds, 'amandaOptional') && !risk(amandaHolds, 'amandaRequired')
  && same(risk(amandaHolds, 'amandaOptional').windowImpact, HAND_THREE_MONTH),
  'no needed-by date selects amandaOptional at the same $6,546');

const noAmanda = run(adviceOf(), debtOf(), { transfer: { amount: 0, neededBy: null } });
ok(!risk(noAmanda, 'amandaRequired') && !risk(noAmanda, 'amandaOptional'),
  'a $0 transfer is omitted — the page used `> 0`');

const HAND_EST = 786;
const withEst = run(adviceOf(), debtOf());
ok(risk(withEst, 'estimatedCommitments')
  && same(risk(withEst, 'estimatedCommitments').count, 1)
  && same(risk(withEst, 'estimatedCommitments').total, HAND_EST),
  'one estimated commitment of $786 is shown; the confirmed $320 is not in the total');

const disabledEst = run(adviceOf(), debtOf(), { disabled: ['est1'] });
ok(!risk(disabledEst, 'estimatedCommitments'),
  'toggling that commitment off omits the risk');

const drawn = run(adviceOf({
  funding: { feasible: true, shortfall: 0, parts: [{ debtId: 'heloc', amount: 623, short: 'HELOC' }] },
}), debtOf({ helocDay: 52 }), { alternatives: { gapFundingAlternatives: [] } });
ok(risk(drawn, 'helocDrawn') && same(risk(drawn, 'helocDrawn').drawn, 623)
  && same(risk(drawn, 'helocDrawn').monthlyInterest, 814.18),
  'a $623 HELOC part selects helocDrawn and carries the $814.18 obligation');

const noDraw = run(adviceOf(), debtOf({ helocDay: 52 }), {
  alternatives: { gapFundingAlternatives: [] },
});
ok(risk(noDraw, 'helocNoDraw') && same(risk(noDraw, 'helocNoDraw').drawn, 0) && !risk(noDraw, 'helocDrawn'),
  'no HELOC part selects helocNoDraw');

const withAlt = run(adviceOf(), debtOf({ helocDay: 52 }), {
  alternatives: { gapFundingAlternatives: [{
    debtId: 'heloc', applies: true,
    displaces: ["Amanda's transfer"],
    alternateCrossing: { date: '2026-08-31' },
  }] },
});
ok(risk(withAlt, 'helocNoDraw') && risk(withAlt, 'helocNoDraw').alternative
  && risk(withAlt, 'helocNoDraw').alternative.alternateDate === '2026-08-31',
  'an applying HELOC alternative is selected from counterfactuals, not re-run');

const later = run(adviceOf(), debtOf({
  extraCrossings: [
    { id: 'triangle', label: 'Triangle Mastercard', alreadyOver: false, date: '2026-08-09' },
    { id: 'cashback', label: 'TD Cash Back Visa', alreadyOver: true, date: '2026-08-09' },
  ],
}));
const crossings = (later.risks || []).filter(r => r.id === 'facilityCrossing');
ok(crossings.length === 1 && crossings[0].debtId === 'triangle',
  'already-over facilities are omitted; Triangle at day 0 with alreadyOver false is shown');

const telecomOn = run(adviceOf(), debtOf(), {
  budget: { categories: [{ id: 'telecom', planned: 140.43 }] },
});
ok(risk(telecomOn, 'telecomUnrouted') && same(risk(telecomOn, 'telecomUnrouted').planned, 140.43),
  'telecom planned $140.43 is shown');
const telecomOff = run(adviceOf(), debtOf(), {
  budget: { categories: [{ id: 'telecom', planned: 0 }] },
});
ok(!risk(telecomOff, 'telecomUnrouted'),
  'telecom planned $0 is omitted — the page used `> 0`');

console.log('\n=== live plan: independent of planPhases ===');
const plan = data.plan;
const asOf = data.meta.asOf;
const liveAdvice = F.recommend(plan, asOf, {
  scenario: plan.defaults.scenario,
  targetBuffer: plan.defaults.targetBuffer,
  extraDebtMonthly: 0, incomeOverrides: {}, disabled: [],
  debts: data.debts, extraDebtTarget: plan.nextDollar.target,
  fundingSources: plan.funding.options,
});
const liveSim = liveAdvice.sim;
const liveDebt = F.projectDebts(plan, data.debts, asOf, Object.assign({},
  liveAdvice.simOptions, { weeklyVariable: liveAdvice.weekly,
    extraFacilities: data.revolvingExtra,
    extraDebtTarget: plan.nextDollar && plan.nextDollar.target }));
const liveBudget = F.budgetBreakdown(plan, periods, {
  paypalPerMonth: data.paypal ? data.paypal.perMonth : 0,
  disabled: [], weeklyCap: liveAdvice.weekly, recommendedWeekly: liveAdvice.weekly,
});
const liveTransfer = F.amandaHouseholdIncomeDeadline(plan, asOf,
  Object.assign({}, liveAdvice.simOptions, {
    weeklyVariable: liveAdvice.weekly, incomeOverrides: {},
    notBefore: liveAdvice.gap ? liveAdvice.gap.date : asOf,
  }));
const liveAlt = F.counterfactuals(plan, asOf, liveAdvice, liveDebt, {
  debts: data.debts, extraFacilities: data.revolvingExtra, weekly: liveAdvice.weekly,
});

const liveMark = n => liveDebt.marks.find(m => m.day === n)
  || liveDebt.marks[liveDebt.marks.length - 1];
const liveToday = liveMark(0);
const liveDay90 = liveDebt.marks[liveDebt.marks.length - 1];
const liveOver = liveToday.debts.filter(x => x.overLimit);
const liveHeloc = (liveDebt.crossings || []).find(c => c.id === 'heloc' && !c.alreadyOver) || null;
const liveEstRows = (plan.commitments || []).filter(c => c.confidence === 'estimated'
  && !(c.settledOn && c.settledOn <= asOf) && c.amount != null);
const liveEst = liveEstRows.reduce((s, c) => s + c.amount, 0);
const liveEstCount = liveEstRows.length;
ok(liveOver.length >= 1,
  'live comparisons: at least one facility is over today');
ok(!liveHeloc,
  'live HELOC does not cross its limit in the 91-day window once the cash minimum is on the walk');
const amanda15 = plan.income.find(s => s.id === 'amandaSalary15');
const amandaEom = plan.income.find(s => s.id === 'amandaSalaryMonthEnd');
const amandaAmt = amanda15 && amandaEom
  ? Math.round((amanda15.amount + amandaEom.amount) * 100) / 100
  : 0;
ok(same(liveTransfer.amount, amandaAmt),
  'live Amanda household income is the combined Tennis BC salary monthly amount',
  liveTransfer ? `$${liveTransfer.amount}` : 'none');
ok(!liveTransfer.neededBy || liveTransfer.neededBy >= asOf,
  'a published needed-by date, when there is one, is in-window',
  liveTransfer.neededBy || 'optional on this opening');
ok(liveTransfer && typeof liveTransfer.endingWithout === 'number',
  'Amanda deadline still reports the no-salary ending');

const live = F.planPhases(plan, liveAdvice, liveDebt, {
  sim: liveSim, budget: liveBudget, transfer: liveTransfer, alternatives: liveAlt, disabled: [],
});
ok(/overLimit/.test(titles(live)) && /surplusToPrincipal|stopGrowth|holdBuffer|coverGap/.test(titles(live)),
  'live titles follow the independent comparisons',
  titles(live));
ok(live.phases[1].titleId === 'overLimit',
  'live 31–60 is the over-limit phase');
const amandaRisk = risk(live, 'amandaRequired') || risk(live, 'amandaOptional');
ok(amandaRisk && same(amandaRisk.windowImpact, amandaAmt * 3),
  'live Amanda risk is three months of the combined Tennis BC salary',
  amandaRisk && amandaRisk.id);
ok(!!risk(live, 'amandaRequired') === !!liveTransfer.neededBy,
  'required vs optional follows whether a needed-by date exists');
ok(risk(live, 'estimatedCommitments') && risk(live, 'estimatedCommitments').count >= 1,
  'live estimated commitments are named from the Plan rows');
ok(!risk(live, 'helocNoDraw') && !risk(live, 'helocDrawn'),
  'live HELOC risk is omitted — the cash-minimum walk does not cross and does not draw');
ok((live.risks || []).filter(r => r.id === 'facilityCrossing')
    .map(r => r.debtId).join(',')
  === (liveDebt.crossings || []).filter(c => !c.alreadyOver && c.id !== 'heloc').map(c => c.id).join(','),
  'live later crossings follow the debt projection, excluding already-over cards and the HELOC');
ok(!risk(live, 'telecomUnrouted'),
  'live telecom remainder risk is gone — card-paid Bell is reserved on the cash walk');

const liveMission = F.mission(liveAdvice, liveDebt, { sim: liveSim });
ok(!!liveMission.parts.find(p => p.id === 'overLimit') === (live.phases[1].titleId === 'overLimit'),
  'live over-limit-today is the same fact the mission already uses');
ok(!liveMission.parts.find(p => p.id === 'helocLimit'),
  'live mission has no HELOC-crossing part on this cash-minimum walk');

console.log('\n=== page is a renderer ===');
const page = read('public/plan.js');
const pageCode = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const { pageCodeMatching, pageScriptsMatching } = require('./lib/page-scripts');
// Positive "the classic page reads Forecast.X" assertions stay on plan.js and retire with it (C1 S7, docs/C1_TEST_DISPOSITIONS.md Q4);
// the "never" assertions read every page script, the Stack page included.
const never = (...res) => pageCodeMatching(...res);
ok(/Forecast\.planPhases\(/.test(page),
  'the Plan page reads phases and risks from Forecast.planPhases');
ok(/PHASE_TITLE\[p\.titleId\]/.test(page) && /RISK_WHAT\[r\.id\]/.test(page),
  'the page looks titles and risk copy up from wording maps');
ok(never(/day90\.consumer\s*</, /d60\.consumer\s*</).length === 0,
  'the page no longer compares consumer marks to pick a title or direction (no page script, classic or Stack)', never(/day90\.consumer\s*</, /d60\.consumer\s*</).join(', ') || 'none');
ok(never(/transferMonthly\s*\*\s*3/).length === 0,
  'the page no longer multiplies the transfer by 3 (no page script, classic or Stack)', never(/transferMonthly\s*\*\s*3/).join(', ') || 'none');
ok(never(/helocDrawn\s*>\s*0/).length === 0,
  'the page no longer decides whether this plan draws on the HELOC (no page script, classic or Stack)', never(/helocDrawn\s*>\s*0/).join(', ') || 'none');
ok(never(/status\.id === 'unfunded'/).length === 0,
  'the page no longer re-reads the status verdict to pick the opening body (no page script, classic or Stack)', never(/status\.id === 'unfunded'/).join(', ') || 'none');
ok(never(/helocBreach && helocBreach\.day <= 60/).length === 0,
  'the page no longer tests the HELOC day against 60 (no page script, classic or Stack)', never(/helocBreach && helocBreach\.day <= 60/).join(', ') || 'none');
ok(/The cap assumes spending is paid in cash/.test(page),
  'the always-on cash-not-cards line stays on the page as copy');

console.log('\n=== mutation: flipping the incumbent comparisons now fails ===');
const FORECAST_SRC = read('public/forecast.js');
const FROM_FELL = '    const consumerFell = day90 && today ? day90.consumer < today.consumer : false;';
const TO_FELL = '    const consumerFell = day90 && today ? day90.consumer > today.consumer : false;';
const FROM_THREE = '      const windowImpact = transfer.amount * 3;';
const TO_THREE = '      const windowImpact = transfer.amount * 2;';
ok(FORECAST_SRC.split(FROM_FELL).length - 1 === 1,
  'the 61–90 consumer comparison appears once in the engine, so the mutation is aimed');
ok(FORECAST_SRC.split(FROM_THREE).length - 1 === 1,
  'the × 3 window impact appears once in the engine, so the mutation is aimed');
const sandbox = { module: { exports: {} } };
try {
  vm.runInNewContext(
    FORECAST_SRC.replace(FROM_FELL, TO_FELL).replace(FROM_THREE, TO_THREE),
    sandbox, { filename: 'forecast-mutant.js' });
} catch (e) {
  ok(false, 'mutant engine loads', e.message);
}
const mutant = sandbox.module.exports;
const brokenTitles = mutant && mutant.planPhases(PLAN, adviceOf(), debtOf({ c90: 8000 }), { sim: SIM });
ok(mutant && brokenTitles && brokenTitles.phases[2].titleId === 'stopGrowth'
  && withGap.phases[2].titleId === 'surplusToPrincipal',
  'flipping `<` to `>` titles a falling consumer Stop the growth');
const brokenImpact = mutant && mutant.planPhases(PLAN, adviceOf(), debtOf(), {
  sim: SIM, transfer: { amount: HAND_TRANSFER, neededBy: '2026-08-23' },
});
ok(mutant && brokenImpact && same(risk(brokenImpact, 'amandaRequired').windowImpact, HAND_TRANSFER * 2)
  && !same(risk(brokenImpact, 'amandaRequired').windowImpact, HAND_THREE_MONTH),
  'halving × 3 publishes $4,364 instead of $6,546',
  brokenImpact ? String(risk(brokenImpact, 'amandaRequired').windowImpact) : 'mutant missing');
ok(same(risk(amandaNeed, 'amandaRequired').windowImpact, HAND_THREE_MONTH)
  && withGap.phases[2].titleId === 'surplusToPrincipal',
  'the real engine still answers the hand-computed title and $6,546 on the same fixtures');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
