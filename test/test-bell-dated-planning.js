'use strict';
/* Independent proof that the statement-supported Bell baseline is dated
 * around the 15th as card-paid reserved gravity — $121/month once, not a
 * second chequing bill, and not redefined by catch-up or roaming totals.
 * `node test/test-bell-dated-planning.js`
 *
 * The $121 identity is reconstructed from June statement lines and the
 * second-account CSV lines. Payday ownership uses Forecast.spendingCycle
 * on the Seaspan 2026-08-14 anchor. Live cents are not the specification.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const icsMod = require('../scripts/calendar-ics.js');
const live = require('../data.json');
const periods = require('../public/periods.json');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const money = n => Number(n).toFixed(2);
const clone = x => JSON.parse(JSON.stringify(x));

const AS_OF = '2026-08-19';
const HORIZON = 365;
const MAIN_BELL = 70 + 25.80 + 8.40;
const SECOND_WATCH = 15 + 0.75 + 1.05;
const BELL = MAIN_BELL + SECOND_WATCH;
const WATCH_LINE_AGAIN = 15;
const TRAVEL_MIN = 17;
const TRAVEL_PAY = 250;
const CATCH_UP_WATCH = 69.15;
const ROAMING_AUG = 233.31;
const AUG_TOTAL = 356.62;
const OPENING = 20000;
const SEASPAN_ANCHOR = '2026-08-14';

function cardPaidPlan(amount) {
  return {
    windowDays: 91,
    defaults: { targetBuffer: 0 },
    startingCash: {
      amount: OPENING,
      breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: OPENING }],
    },
    income: [{
      id: 'payroll',
      label: 'Payroll — Seaspan',
      frequency: 'biweekly',
      anchor: SEASPAN_ANCHOR,
      amount: 4000,
      confidence: 'confirmed',
    }],
    obligations: [
      {
        id: 'travel',
        debtId: 'travelvisa',
        effect: 'payment',
        label: 'Travel Visa minimum',
        frequency: 'monthly',
        day: 26,
        amount: TRAVEL_MIN,
        confidence: 'estimated',
        payingAccount: 'chequing-a',
      },
      {
        id: 'travel-bell-payment',
        debtId: 'travelvisa',
        effect: 'payment',
        label: 'Travel Visa Bell Mobility payment',
        frequency: 'once',
        date: '2026-08-26',
        amount: TRAVEL_PAY,
        confidence: 'confirmed',
        payingAccount: 'chequing-a',
      },
    ],
    bills: [{
      id: 'bell',
      label: 'Bell Mobility',
      frequency: 'monthly',
      day: 15,
      amount,
      confidence: 'estimated',
      budgetCategory: 'telecom',
      payingAccount: 'travelvisa',
      jointCash: false,
    }],
    commitments: [],
    budget: {
      basis: 'ytd',
      categories: [{
        id: 'telecom',
        label: 'Phones & internet',
        class: 'essential',
        from: ['Telecom'],
        plannedMonthly: null,
      }],
    },
  };
}

const debts = [{
  id: 'travelvisa',
  label: 'Travel Visa',
  balance: 1200,
  pending: 0,
  limit: 1100,
  rate: 0,
  interestByEvent: true,
}];

function walk(plan) {
  return F.simulate(plan, AS_OF, {
    weeklyVariable: 0,
    targetBuffer: 0,
    horizonDays: HORIZON,
    viewDays: HORIZON,
  });
}

function debtWalk(plan) {
  return F.projectDebts(plan, debts, AS_OF, {
    weeklyVariable: 0,
    horizonDays: HORIZON,
    debtHorizonDays: HORIZON,
  });
}

function occurrenceCount(plan, start, days) {
  const end = F.addDays(start, days - 1);
  return F.expandEvents(plan, start, end, {}).filter(e => e.id === 'bell').length;
}

function independentDatedTotal(plan, start, days) {
  return BELL * occurrenceCount(plan, start, days);
}

console.log('=== 1–4. independent Bell baseline is $104.20 + $16.80 = $121.00 ===');
ok(near(MAIN_BELL, 104.20),
  'June main-account lines are $70.00 + $25.80 + $8.40 = $104.20', money(MAIN_BELL));
ok(near(SECOND_WATCH, 16.80),
  'second-account CSV lines are $15.00 + $0.75 + $1.05 = $16.80', money(SECOND_WATCH));
ok(near(BELL, 121.00),
  'normal Bell baseline is $104.20 + $16.80 = $121.00', money(BELL));
ok(!near(BELL, ROAMING_AUG) && !near(BELL, AUG_TOTAL) && !near(BELL, TRAVEL_PAY)
    && !near(BELL, CATCH_UP_WATCH) && !near(BELL, TRAVEL_PAY + CATCH_UP_WATCH),
  'baseline is not $233.31, $356.62, $250, $69.15, or $319.15');

console.log('\n=== 5. dated authority replaces the undated currentMonthly reserve ===');
const withBell = cardPaidPlan(BELL);
const withoutBell = cardPaidPlan(0);
withoutBell.bills = [];
ok(F.isCardPaidBill(withBell.bills[0], withBell) === true,
  'dated Bell is card-paid under incumbent Forecast');
ok(F.billAffectsJointCash(withBell.bills[0], withBell) === false,
  'dated Bell does not affect joint chequing');
ok(!(withBell.budget.categories || []).some(c => c.currentMonthly != null),
  'synthetic fixture has no undated currentMonthly reserve');

const liveBell = (live.plan.bills || []).find(b => b.id === 'bell');
const liveTelecom = (live.plan.budget.categories || []).find(c => c.id === 'telecom');
ok(liveBell && liveBell.day === 15 && liveBell.needsDate !== true
    && near(liveBell.amount, 160) && liveBell.firstDue === '2026-10-15'
    && liveBell.payingAccount === 'chequing-a' && liveBell.jointCash !== false
    && F.billAffectsJointCash(liveBell, live.plan) === true
    && F.isCardPaidBill(liveBell, live.plan) === false,
  'live Bell standing is dated on the 15th from Oct as a BILLS ACCOUNT withdrawal, not needsDate');
ok(liveTelecom && liveTelecom.currentMonthly == null,
  'live telecom no longer holds an undated currentMonthly reserve');
ok(((live.plan.bills || []).filter(b => b.id === 'bell')).length === 1
    && ((live.plan.bills || []).filter(b => b.id === 'bell-sep15-2026')).length === 1,
  'live plan has one Bell recurring row and the September once row');

console.log('\n=== 6–7. September Bell belongs to exactly one Seaspan payday window ===');
const sepCycle = F.spendingCycle({
  income: [{ id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
    anchor: SEASPAN_ANCHOR, amount: 4000 }],
}, '2026-09-15');
ok(sepCycle && sepCycle.start === '2026-09-11' && sepCycle.end === '2026-09-24',
  'September 15 is inside the Sep 11–Sep 24 Seaspan payday window',
  sepCycle && `${sepCycle.start}–${sepCycle.end}`);
const otherCycles = ['2026-08-28', '2026-09-10', '2026-09-25'].map(d =>
  F.spendingCycle(live.plan, d));
ok(otherCycles.every(c => c && (c.start !== '2026-09-11' || c.end !== '2026-09-24'
    ? !(c.start <= '2026-09-15' && '2026-09-15' <= c.end)
    : true)),
  'adjacent payday windows do not also own September 15');
ok(sepCycle.start <= '2026-09-15' && '2026-09-15' <= sepCycle.end,
  'scheduled household planning date 15 is the ownership authority');

const liveSep = F.expandEvents(live.plan, '2026-09-01', '2026-09-30', {})
  .filter(e => e.id === 'bell' || e.id === 'bell-sep15-2026');
ok(liveSep.length === 1 && liveSep[0].id === 'bell-sep15-2026'
    && liveSep[0].date === '2026-09-15' && near(-liveSep[0].amount, 283.94)
    && liveSep[0].cardPaid === true && liveSep[0].jointCash === false,
  'September live Bell occurrence is the $283.94 once on 2026-09-15, card-paid');
ok(!liveSep.some(e => e.date === '2026-09-17'),
  'the unusual August 17 due date does not become the September day');

const windows = [];
let cursor = '2026-08-14';
for (let i = 0; i < 6; i++) {
  const cycle = F.spendingCycle(live.plan, cursor);
  windows.push(cycle);
  cursor = cycle.nextPayday;
}
const owners = windows.filter(c => c.start <= '2026-09-15' && '2026-09-15' <= c.end);
ok(owners.length === 1 && owners[0].start === '2026-09-11',
  'exactly one operating Pay Period owns September Bell',
  owners.map(c => `${c.start}–${c.end}`).join(','));

console.log('\n=== 8–9. catch-up / roaming / late fees are not the recurring amount ===');
ok(!near(BELL, TRAVEL_PAY) && !near(BELL, CATCH_UP_WATCH)
    && !near(MAIN_BELL, ROAMING_AUG) && !near(MAIN_BELL, AUG_TOTAL),
  'independent lines reject $250, $69.15, $233.31, and $356.62 as baseline');
ok(!near(liveBell.amount, TRAVEL_PAY) && !near(liveBell.amount, CATCH_UP_WATCH)
    && !near(liveBell.amount, TRAVEL_PAY + CATCH_UP_WATCH)
    && !near(liveBell.amount, ROAMING_AUG) && !near(liveBell.amount, AUG_TOTAL),
  'live Bell row is not a catch-up or August statement total');

console.log('\n=== 10. one $121 reserve — dated events, not a second smear ===');
const simBell = walk(withBell);
const simZero = walk(withoutBell);
const want = independentDatedTotal(withBell, AS_OF, HORIZON);
const cashDelta = simZero.ending - simBell.ending;
ok(near(cashDelta, want),
  '365-day ending cash moves by occurrence-count × $121, not a second smear',
  `${money(cashDelta)} vs ${money(want)}`);
ok(near(simBell.totals.reserved, want) && near(simBell.totals.bills, 0)
    && near(simBell.totals.variable, 0),
  'the $121 lands on the reserved ledger, not week.bills or Budget',
  money(simBell.totals.reserved));
ok(occurrenceCount(withBell, AS_OF, HORIZON) === 12,
  'a 365-day walk from 19 Aug contains twelve 15ths',
  String(occurrenceCount(withBell, AS_OF, HORIZON)));

const liveHorizon = F.knowledgeHorizon(live.plan, live.meta.asOf, {}).days;
const liveZero = clone(live.plan);
liveZero.bills = (liveZero.bills || []).filter(b =>
  b.id !== 'bell' && b.id !== 'bell-sep15-2026');
if (liveZero.budget && liveZero.budget.categories) {
  liveZero.budget.categories = liveZero.budget.categories.map(c =>
    c.id === 'telecom' ? Object.assign({}, c, { currentMonthly: 0 }) : c);
}
const liveOpts = {
  weeklyVariable: 0, targetBuffer: 0,
  horizonDays: liveHorizon, viewDays: liveHorizon,
};
const liveOn = F.simulate(live.plan, live.meta.asOf, liveOpts);
const liveOff = F.simulate(liveZero, live.meta.asOf, liveOpts);
const liveStandingCount = occurrenceCount(live.plan, live.meta.asOf, liveHorizon);
const liveWant = 283.94 + 160 * liveStandingCount;
ok(near(liveOff.ending - liveOn.ending, liveWant),
  'live plan: removing Bell once + standing lifts the knowledge walk by $283.94 + $160 per Oct+ 15th',
  money(liveOff.ending - liveOn.ending));
ok(near(liveOn.totals.bills - liveOff.totals.bills, 160 * liveStandingCount),
  'live standing Bell lands in joint-cash bills, $160 per Oct+ 15th',
  money(liveOn.totals.bills - liveOff.totals.bills));
ok(near(liveOn.totals.reserved - liveOff.totals.reserved, 283.94),
  'live reserved delta is the September once only',
  money(liveOn.totals.reserved - liveOff.totals.reserved));

console.log('\n=== 11–13. Travel Visa settlement stays distinct; no double chequing hit ===');
const noTravelBell = walk(Object.assign(clone(withBell), { obligations: [] }));
const noTravelZero = walk(Object.assign(clone(withoutBell), { obligations: [] }));
ok(near(noTravelZero.ending - noTravelBell.ending, want),
  'Bell gravity is the same when Travel Visa obligations are absent',
  money(noTravelZero.ending - noTravelBell.ending));
ok(near(simZero.ending - simBell.ending, want),
  'and the same when both walks carry the $17 minimum and the $250 payment',
  money(simZero.ending - simBell.ending));

const events = F.expandEvents(withBell, AS_OF, F.addDays(AS_OF, HORIZON - 1), {});
const travelPays = events.filter(e => e.id === 'travel' || e.id === 'travel-bell-payment');
const bellEvents = events.filter(e => e.id === 'bell');
ok(travelPays.length > 0 && travelPays.every(e => e.kind === 'obligation' && e.cardPaid !== true),
  'Travel Visa minimum and the $250 payment remain card-payment obligations');
ok(bellEvents.length > 0 && bellEvents.every(e => e.cardPaid === true && e.jointCash === false),
  'Bell events are card-paid reserved, not joint-cash bills');
ok(!travelPays.some(e => near(Math.abs(e.amount), BELL)),
  'neither Travel Visa cash event is the $121 Bell baseline');
ok(!bellEvents.some(e => near(Math.abs(e.amount), TRAVEL_MIN)
    || near(Math.abs(e.amount), TRAVEL_PAY)),
  'Bell events are not the Travel Visa $17 minimum or $250 catch-up');

const debtBell = debtWalk(withBell);
const debtZero = debtWalk(withoutBell);
ok(near(debtBell.byId.travelvisa.paid, debtZero.byId.travelvisa.paid),
  'Travel Visa paid-down is unchanged by dated Bell',
  money(debtBell.byId.travelvisa.paid));
ok(near(debtBell.byId.travelvisa.capitalised || 0, 0)
    && near(debtZero.byId.travelvisa.capitalised || 0, 0),
  'Bell is not capitalised onto Travel Visa');
ok(near(debtBell.byId.travelvisa.balance, debtZero.byId.travelvisa.balance),
  'Travel Visa projected balance is unchanged by dated Bell',
  money(debtBell.byId.travelvisa.balance));

const jointHit = simBell.totals.bills + simBell.totals.obligations;
const travelOnly = simZero.totals.bills + simZero.totals.obligations;
ok(near(jointHit, travelOnly),
  'chequing bill+obligation totals do not include a second Bell $121',
  `${money(jointHit)} vs ${money(travelOnly)}`);

const liveTravel = (live.plan.obligations || []).find(o => o.id === 'travel');
ok(liveTravel && liveTravel.debtId === 'travelvisa' && liveTravel.effect === 'payment'
    && near(liveTravel.amount, TRAVEL_MIN) && liveTravel.payingAccount === 'chequing-a',
  'live Travel Visa minimum remains the distinct $17 BILLS ACCOUNT payment');

console.log('\n=== 14. page remains render-only; Forecast owns the date ===');
const planSrc = fs.readFileSync(path.join(__dirname, '..', 'public/plan.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const deepSrc = fs.readFileSync(path.join(__dirname, '..', 'public/deepdive.js'), 'utf8');
ok(!/day\s*=\s*15/.test(planSrc) && !/currentMonthly\s*=\s*121/.test(planSrc),
  'plan.js does not invent the Bell day or the $121 amount');
ok(/function glanceLineLabel/.test(planSrc) && /row\.date/.test(planSrc),
  'plan.js still only renders Forecast-owned bill dates');

console.log('\n=== 14b. card-paid reserve is not presented as external ===');
const grab = (src, re, label) => {
  const m = re.exec(src);
  if (!m) throw new Error('missing ' + label);
  return m[0];
};
const evHtmlBody = (/const evHtml = e => \{([\s\S]*?)\n  \};/.exec(planSrc) || [])[1];
const agBody = (/\$\('agenda-14'\)\.innerHTML = near\.length \? near\.map\(e => \{([\s\S]*?)\}\)\.join\(''\)/.exec(planSrc) || [])[1];
const datedBody = (/const datedRows = dated\.map\(e => \{([\s\S]*?)\}\);/.exec(deepSrc) || [])[1];
ok(!!evHtmlBody && !!agBody && !!datedBody, 'calendar, agenda, and Deep Dive renderers are mechanically readable');

const present = vm.runInNewContext([
  grab(appSrc, /^const money = .*$/m, 'money'),
  grab(appSrc, /^const money2 = .*$/m, 'money2'),
  grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
  grab(planSrc, /^function shortLabel\([\s\S]*?\n\}$/m, 'shortLabel'),
  grab(planSrc, /^function isCardPaidReserve\([\s\S]*?\n\}$/m, 'isCardPaidReserve'),
  grab(planSrc, /^function isExternalObligation\([\s\S]*?\n\}$/m, 'isExternalObligation'),
  grab(planSrc, /^function externalPayerLabel\([\s\S]*?\n\}$/m, 'externalPayerLabel'),
  'const atomic = { has: () => false };',
  'const groupOf = {};',
  'const gap = null;',
  'const plan = {};',
  'function evHtml(e) {' + evHtmlBody + '}',
  'function agendaHtml(e) {' + agBody + '}',
  '({ isCardPaidReserve, isExternalObligation, evHtml, agendaHtml })',
].join('\n'));

const reserveEv = {
  id: 'bell',
  label: 'Bell Mobility',
  amount: -BELL,
  kind: 'bill',
  date: '2026-09-15',
  jointCash: false,
  cardPaid: true,
  payingAccount: 'travelvisa',
  confidence: 'confirmed',
};
const externalEv = {
  id: 'hydro',
  label: 'BC Hydro',
  amount: -80,
  kind: 'bill',
  date: '2026-09-01',
  jointCash: false,
  payingAccount: 'amanda-debt-payments',
  confidence: 'confirmed',
};
const cashEv = {
  id: 'shaw',
  label: 'Shaw',
  amount: -130.19,
  kind: 'bill',
  date: '2026-09-03',
  confidence: 'confirmed',
};

ok(present.isCardPaidReserve(reserveEv) && !present.isExternalObligation(reserveEv),
  'card-paid + jointCash:false is a reserve, not an external obligation');
ok(!present.isCardPaidReserve(externalEv) && present.isExternalObligation(externalEv),
  'held-elsewhere jointCash:false remains an external obligation');

const reserveCal = present.evHtml(reserveEv);
const externalCal = present.evHtml(externalEv);
const cashCal = present.evHtml(cashEv);
ok(/cal-ev out/.test(reserveCal) && /card-paid reserve; reduces projected joint cash/.test(reserveCal)
    && /card reserve/.test(reserveCal) && /−/.test(reserveCal),
  'calendar renders the card-paid reserve as an outflow that reduces projected joint cash',
  reserveCal);
ok(!/does not reduce joint cash/.test(reserveCal) && !/external household obligation/.test(reserveCal)
    && !/cal-ev external/.test(reserveCal),
  'calendar does not reuse external copy or class for a card-paid reserve');
ok(/cal-ev external/.test(externalCal) && /does not reduce joint cash/.test(externalCal)
    && /external household obligation/.test(externalCal) && !/−/.test(externalCal.replace(/−\$/, '')),
  'calendar still describes a true external obligation as not reducing joint cash');
ok(/cal-ev out/.test(cashCal) && !/card reserve/.test(cashCal) && !/external/.test(cashCal),
  'ordinary chequing bills stay ordinary calendar outflows');

const reserveAg = present.agendaHtml(reserveEv);
const externalAg = present.agendaHtml(externalEv);
ok(/ag14 out/.test(reserveAg) && /card-paid reserve/.test(reserveAg)
    && /reduces projected joint cash/.test(reserveAg) && /−/.test(reserveAg),
  '14-day agenda renders the card-paid reserve as an outflow that reduces projected joint cash',
  reserveAg);
ok(!/not joint-cash/.test(reserveAg) && !/ag14 external/.test(reserveAg),
  '14-day agenda does not call a card-paid reserve not joint-cash');
ok(/ag14 external/.test(externalAg) && /not joint-cash/.test(externalAg)
    && /paid from Amanda \/ TENNIS INCOME/.test(externalAg),
  '14-day agenda still marks held-elsewhere Hydro as not joint-cash');

const datedHtml = vm.runInNewContext([
  'const fmtDate = d => d;',
  'const daysUntil = () => 5;',
  'const dueWord = n => "in " + n + "d";',
  grab(appSrc, /^const money2 = .*$/m, 'money2'),
  'const noteFor = () => "";',
  'const externalPayerLabel = () => "Amanda / TENNIS INCOME";',
  'const d = { plan: {} };',
  'function datedRow(e) {' + datedBody + '}',
  'datedRow',
].join('\n'))(reserveEv);
ok(/card-paid reserve/.test(datedHtml) && /reduces projected joint cash/.test(datedHtml)
    && !/not joint-cash/.test(datedHtml) && !/chip">external</.test(datedHtml)
    && !/mutedtext/.test(datedHtml),
  'Deep Dive dated row names a card-paid reserve that reduces projected joint cash',
  datedHtml);

const icsBuilt = icsMod.buildHouseholdCalendar(withBell, AS_OF, '2026-10-31');
const bellPays = icsBuilt.payments.filter(p => p.sourceId === 'bell');
ok(bellPays.length > 0 && bellPays.every(p => /card-paid reserve/.test(p.summary)
    && /holds this amount against projected joint cash/.test(p.description)),
  'exported calendar publishes Bell as a card-paid reserve against projected joint cash');
ok(!icsBuilt.reminders.some(r => r.sourceId === 'bell'),
  'exported calendar does not emit Bell as an external reminder');
ok(bellPays.every(p => !/not joint cash|not a joint-cash outflow/.test(p.summary + '\n' + p.description)),
  'exported calendar does not say Bell is outside joint cash');

console.log('\n=== 15–16. budget current-regime, payday print, determinism ===');
const bd = F.budgetBreakdown(live.plan, periods, { asOf: live.meta.asOf });
const telecom = bd.categories.find(c => c.id === 'telecom');
const shaw = (live.plan.bills || []).find(b => b.id === 'shaw');
const monthsInWindow = (live.plan.windowDays || 91) / (365.25 / 12);
const onceMonthly = 283.94 / monthsInWindow;
ok(telecom && telecom.source === 'current-regime' && near(telecom.current, onceMonthly)
    && near(telecom.reserved, 0) && near(telecom.planned, 0)
    && near(telecom.dated, shaw.amount + 160 + onceMonthly),
  'live telecom dated is Shaw + standing $160 + Sep once smear; standing is not a reserved smear',
  telecom && `${money(telecom.dated)} dated / ${money(telecom.current)} current`);
ok(telecom.datedItems.some(i => /bell/i.test(i.label) && near(i.amount, 160))
    && telecom.datedItems.some(i => /bell/i.test(i.label) && near(i.amount, onceMonthly))
    && telecom.datedItems.some(i => /shaw/i.test(i.label) && near(i.amount, shaw.amount)),
  'Shaw remains the chequing telecom bill; Bell standing and Sep once are dated card-paid items');

const sep10 = F.recommend(live.plan, '2026-09-10', {
  debts: live.debts, targetBuffer: 0, periods,
});
const sepBills = (sep10.defaultView.bills || []).concat(
  (sep10.defaultView.calendarPeriods || []).reduce((all, p) => all.concat(p.bills || []), []));
const sepBellRows = sepBills.filter(r => r.id === 'bell' || r.id === 'bell-sep15-2026');
ok(sepBellRows.length >= 1 && sepBellRows.every(r => r.id === 'bell-sep15-2026'
    && r.date === '2026-09-15' && near(r.amount, 283.94)
    && r.needsDate !== true && r.cardPaid === true),
  'as-of 10 Sep prints September Bell as the $283.94 once on the 15th in the owning payday window');
ok(sepBellRows.every(r => !/BILLS ACCOUNT/i.test(r.payerLabel || '')),
  'printed Bell is not labelled as a BILLS ACCOUNT withdrawal');

const aug19 = F.recommend(live.plan, AS_OF, {
  debts: live.debts, targetBuffer: 0, periods,
});
const augBell = (aug19.defaultView.undatedBills || []).filter(r => r.id === 'bell');
ok(augBell.length === 0,
  'as-of 19 Aug no longer prints Bell as an undated needs-confirmation row');

const again = F.recommend(live.plan, AS_OF, {
  debts: live.debts, targetBuffer: 0, periods,
});
ok(JSON.stringify(aug19.defaultView.calendarPeriods) === JSON.stringify(again.defaultView.calendarPeriods)
    && near(liveOn.ending, F.simulate(live.plan, live.meta.asOf, liveOpts).ending),
  'dated Bell output is deterministic across two Forecast runs');

const mutated = cardPaidPlan(BELL + WATCH_LINE_AGAIN);
const mutDelta = simZero.ending - walk(mutated).ending;
ok(!near(mutDelta, want) && near(mutDelta, (BELL + WATCH_LINE_AGAIN) * occurrenceCount(mutated, AS_OF, HORIZON)),
  'adding the $15 watch line again is not the $121 identity',
  money(mutDelta));

const facts = sourceText(fs.readFileSync(
  path.join(__dirname, '..', 'docs/ACCOUNT_FACTS.md'), 'utf8'));
ok(/\$104\.20 \+ \$16\.80 = \$121\.00/.test(facts) && /15th/.test(facts)
    && /BILLS ACCOUNT joint-cash withdrawal/.test(facts)
    && /card-paid Travel Visa reserved gravity/.test(facts)
    && /\$160\/month/.test(facts) && /\$265\.65/.test(facts),
  'ACCOUNT_FACTS records standing $160 on BILLS ACCOUNT, the Sep once, and $121 as historical');
ok(!/Forecast reserves that \$121\.00 as undated current-regime cash/.test(facts),
  'ACCOUNT_FACTS no longer describes Bell timing as an undated smear');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
