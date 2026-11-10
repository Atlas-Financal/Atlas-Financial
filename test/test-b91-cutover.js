'use strict';
/* B91 current-state cutover — 2026-08-16 opening from the freshest complete
 * evidence. Forecast remains the only financial engine. Observation files
 * remain evidence. The reconciler still does not write data.json.
 *
 * Independent proof: plan-row arithmetic and source identities, not a second
 * call to recommendWeekly.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const F = require('../public/forecast.js');
const R = require('../scripts/reconcile.js');
const live = require('../data.json');
const AUG16_REV = '28d08a12a18691f34c32bc839d22cd526fc75111';
const aug16Pinned = JSON.parse(execFileSync('git', ['show', `${AUG16_REV}:data.json`], { encoding: 'utf8' }));
const settlements = require('../docs/reconciliation/commitment-settlements.json');
const posting = require('../docs/reconciliation/posting-observations.json');
const cards = require('../docs/reconciliation/card-state-observations.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const money = n => '$' + Number(n).toFixed(2);
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const PAYDAY = '2026-08-14';
const AUG9 = '2026-08-09';
const AUG16 = '2026-08-16';
const NEXT_PAY = '2026-08-28';
const CAMP = 786;
const TRYOUTS = 140;
const HYDRO_SEP = 237.45;
const BUFFER = live.plan.defaults.targetBuffer;
const AMANDA = 'amanda-debt-payments';

function independentSpendable(plan) {
  return (plan.startingCash.breakdown || [])
    .filter(b => b && (b.id === 'chequing-a' || b.id === 'chequing-b'))
    .reduce((s, b) => s + Number(b.value || 0), 0);
}
function liveOpts() {
  return {
    scenario: 'expected', incomeOverrides: {}, disabled: [], extraDebtMonthly: 0,
    targetBuffer: BUFFER,
    fundingSources: live.plan.funding && live.plan.funding.options,
    debts: live.debts,
    extraFacilities: live.revolvingExtra,
    extraDebtTarget: live.plan.nextDollar && live.plan.nextDollar.target,
  };
}
function windowEnd(start) {
  return F.addDays(start, (live.plan.windowDays || 91) - 1);
}
function questionsMarkdown() {
  return fs.readFileSync(path.join(__dirname, '..', 'docs', '01_OPEN_QUESTIONS.md'), 'utf8');
}
function questionStatus(md, id) {
  const re = new RegExp('### ' + id + '\\.[\\s\\S]*?\\*\\*Status:\\*\\*\\s*([^\\n]+)');
  const m = re.exec(md);
  return m ? m[1].trim() : null;
}

const camp = live.plan.commitments.find(c => c.id === 'fusioncamp');
const tryouts = live.plan.commitments.find(c => c.id === 'tryouts');
const hydroSep = (live.plan.bills || []).find(b => b.id === 'hydro-due-sep1');
const hydroNow = (live.plan.bills || []).find(b => b.id === 'hydro-due-now');
const opening = independentSpendable(live.plan);
const events16 = F.expandEvents(aug16Pinned.plan, AUG16, windowEnd(AUG16), {});
const events14 = F.expandEvents(aug16Pinned.plan, PAYDAY, windowEnd(PAYDAY), {});
const events9 = F.expandEvents(aug16Pinned.plan, AUG9, windowEnd(AUG9), {});

console.log('=== A. pinned 2026-08-16 cutover; spendable cash is independently $2,252.76 ===');
{
  ok(aug16Pinned.meta.asOf === AUG16, 'pinned 28d08a12 as-of is 2026-08-16', aug16Pinned.meta.asOf);
  ok(aug16Pinned.plan.opening && aug16Pinned.plan.opening.asOf === AUG16,
    'pinned plan.opening.asOf is the same cutover');
  ok(Array.isArray(aug16Pinned.plan.opening.representedEvents)
    && aug16Pinned.plan.opening.representedEvents.length === 0,
    'representedEvents is empty — nothing scheduled on 16 August is inside the observation');
  const a = aug16Pinned.plan.startingCash.breakdown.find(r => r.id === 'chequing-a');
  const b = aug16Pinned.plan.startingCash.breakdown.find(r => r.id === 'chequing-b');
  const s = aug16Pinned.plan.startingCash.breakdown.find(r => r.id === 'savings');
  ok(a && near(a.value, 1320.13), 'Chequing A is the mapped $1,320.13', money(a && a.value));
  ok(b && near(b.value, 932.05), 'Chequing B is the mapped $932.05', money(b && b.value));
  ok(s && near(s.value, 0.58), 'Savings is the mapped $0.58', money(s && s.value));
  const independent = 1320.13 + 932.05 + 0.58;
  const pinnedOpening = independentSpendable(aug16Pinned.plan);
  ok(near(independent, 2252.76), 'mapped cash-register total remains $2,252.76', money(independent));
  ok(near(pinnedOpening, 1320.13 + 932.05),
    'independent Forecast spendable opening is chequing-only $2,252.18', money(pinnedOpening));
  ok(near(F.startingCashAmount(aug16Pinned.plan), pinnedOpening),
    'Forecast opening cash is that spendable sum only');
  ok(live.meta.asOf === live.plan.opening.asOf,
    'live meta.asOf still agrees with plan.opening.asOf');
}

console.log('\n=== B. settled commitments do not reserve cash again ===');
ok(camp && near(camp.amount, CAMP) && camp.settledOn === PAYDAY,
  'live fusioncamp row is retained with settledOn 2026-08-14');
ok(tryouts && near(tryouts.amount, TRYOUTS) && tryouts.settledOn === PAYDAY,
  'live tryouts row is retained with settledOn 2026-08-14');
ok(F.commitmentStatus(camp) === 'settled' && F.commitmentStatus(tryouts) === 'settled',
  'derived status is settled; the commitments were not deleted');
ok(events9.some(e => e.id === 'fusioncamp' && near(e.amount, -CAMP)),
  'independent: an Aug. 9 opening still reserves $786');
ok(!events16.some(e => e.id === 'fusioncamp' || e.id === 'tryouts'),
  'the 16 August Forecast emits no Fusion camp or tryouts cash event');
const b1 = live.plan.commitments.find(c => c.id === 'burrard1');
const b2 = live.plan.commitments.find(c => c.id === 'burrard2');
ok(b1 && b1.settledOn === AUG16 && b2 && b2.settledOn === AUG16,
  'Burrards registrations remain settledOn 2026-08-16');
ok(!events16.some(e => e.id === 'burrard1' || e.id === 'burrard2'),
  'the 16 August Forecast emits no Burrards registration cash event');
ok(['fusion-sep', 'fusion-oct', 'fusion-nov'].every(id => {
  return !live.plan.commitments.some(c => c.id === id);
}), 'the three stale $500 Fusion instalments stay gone');

console.log('\n=== C. same-day / already-posted income and transfers are not replayed ===');
{
  const payroll = live.plan.income.find(s => s.id === 'payroll');
  ok(payroll && payroll.amount >= 4247.92 && payroll.amount <= 4274.98,
    'recurring payroll stays inside the EMP-004 observed net range');
  ok(!events16.some(e => e.id === 'payroll' && e.date === PAYDAY),
    '16 August Forecast does not replay 14 August payroll — the date is before as-of');
  ok(events16.some(e => e.id === 'payroll' && e.date === NEXT_PAY),
    'the next payroll on 28 August still fires');
  const amanda15 = live.plan.income.find(s => s.id === 'amandaSalary15');
  const amandaEom = live.plan.income.find(s => s.id === 'amandaSalaryMonthEnd');
  const liveEvents = F.expandEvents(live.plan, live.meta.asOf, windowEnd(live.meta.asOf), {});
  ok(amanda15 && amanda15.firstDue === '2026-09-15',
    '15th salary firstDue is 2026-09-15 so the August 15 occurrence already in cash is not replayed');
  ok(!liveEvents.some(e => e.id === 'amandaSalary15' && e.date < '2026-09-15'),
    'no August 15th salary cash event is emitted from this opening');
  ok(amandaEom && amandaEom.day === 31 && near(amandaEom.amount, 2387.99),
    'month-end salary is the $2,387.99 last-day stream');
  ok(liveEvents.some(e => e.id === 'amandaSalaryMonthEnd' && e.date === '2026-08-31'),
    'August 31 salary is in-window and is not an opening replay');
  ok(!live.plan.income.some(s => s.id === 'amandaTransfer'),
    'retired amandaTransfer stream is not replayed as Forecast income');
}

console.log('\n=== D. posted 14 August obligations are not reserved again ===');
{
  ok(!events16.some(e => e.id === 'mortgage' && e.date === PAYDAY),
    '14 August mortgage is not replayed');
  ok(events16.some(e => e.id === 'mortgage' && e.date === NEXT_PAY),
    '28 August mortgage still fires');
  ok(!events16.some(e => e.id === 'shaw' && e.date === PAYDAY),
    '14 August Shaw is not replayed');
  ok(!events16.some(e => e.id === 'fit4less' && e.date === PAYDAY),
    '14 August Fit4Less is not replayed');
  const tdcc = live.plan.obligations.find(o => o.id === 'tdcc');
  ok(tdcc && tdcc.firstDue === '2026-09-17',
    'TD card firstDue is 2026-09-17 after the posted $94.03 payment');
  ok(!events16.some(e => e.id === 'tdcc' && e.date === '2026-08-17'),
    'the paid August TD-card minimum is not reserved on 17 August');
  ok(!live.plan.obligations.some(o => o.id === 'cashback-sep'),
    'the $762.36 Cash Back September spike row is gone');
  ok(!events16.some(e => e.id === 'cashback-sep' || (e.id === 'cashback' && e.date === '2026-09-01')),
    'Forecast does not reserve the paid Cash Back September spike');
}

console.log('\n=== E. unposted 15 August bills remain reserved; unknown posting is not guessed ===');
{
  const unknownIds = ['bcaa', 'icbc', 'resp'];
  ok(unknownIds.every(id => posting.observations.some(o => o.eventId === id && o.unknown === true)),
    'BCAA / ICBC / RESP remain unknown in posting observations');
  ok(posting.observations.some(o => o.eventId === 'uniondues' && o.unknown === true),
    'historical CMAW posting observation remains unknown evidence, not a Forecast bill');
  for (const id of ['bcaa-aug15-outstanding', 'icbc-aug15-outstanding',
    'resp-aug15-outstanding', 'uniondues-aug15-outstanding']) {
    ok(events16.some(e => e.id === id && e.date === AUG16),
      `${id} is reserved on the pinned 16 August opening`);
  }
  const independentMidMonth = 82.96 + 99.91 + 100 + 25;
  const reserved = events16.filter(e => /aug15-outstanding/.test(e.id))
    .reduce((s, e) => s + (-e.amount), 0);
  ok(near(reserved, independentMidMonth),
    'independent pinned 15 August unposted reserve is $307.87', money(reserved));
  const liveEvents = F.expandEvents(live.plan, live.meta.asOf, windowEnd(live.meta.asOf), {});
  ok(!(live.plan.bills || []).some(b => b.id === 'uniondues-aug15-outstanding' || b.id === 'uniondues')
      && !liveEvents.some(e => e.id === 'uniondues-aug15-outstanding' || e.id === 'uniondues'),
    'current opening no longer reserves cancelled CMAW dues');
  ok(!live.plan.opening.representedEvents.some(e => unknownIds.includes(e.id)),
    'unknown posting was not written onto representedEvents');
  const bcaa = (live.plan.bills || []).find(b => b.id === 'bcaa-aug15-outstanding');
  const bcaaObs = posting.observations.find(o => o.eventId === 'bcaa');
  ok(bcaa && /posting unknown/i.test(bcaa.label),
    'the reserved BCAA row is labelled unknown posting, not confirmed unposted');
  ok(bcaa && !/not in the 2026-08-16 Lunch Money window/i.test(bcaa.note),
    'BCAA does not claim 15 August is outside the 14-day current-state window');
  ok(bcaaObs && bcaaObs.observedAsOf === '2026-08-14' && bcaaObs.unknown === true,
    'BCAA posting provenance stays the Aug. 14 unknown observation');
  ok(!/Still not observed posted in the 2026-08-16 pull/i.test(bcaaObs.note),
    'unknown Aug. 14 provenance is not rewritten as an Aug. 16 confirmed absence');
}

console.log('\n=== F. 2026-08-16 debt openings independently match their source identities ===');
{
  const byId = Object.fromEntries(aug16Pinned.debts.map(d => [d.id, d]));
  ok(near(byId.mortgage.balance, 545188.30)
    && near(546026.58 - 545188.30, 838.28),
    'mortgage $545,188.30 = 546,026.58 − 838.28 principal on the posted $1,600');
  ok(near(byId.heloc.balance, 200486.16)
    && near(201586.16 - 200486.16, 1100),
    'HELOC $200,486.16 = 201,586.16 − the posted $1,100 payment');
  ok(near(byId.triangle.balance, 13197) && near(byId.triangle.pending, 15.62)
    && near(13497 - 300, 13197),
    'Triangle posted $13,197.00 = 13,497.00 − $300 Aug. 10; pending $15.62 stays separate');
  ok(near(13500 - 13197 - 15.62, 287.38),
    'independent Triangle available $287.38 is never treated as cash');
  ok(near(byId.mbna.balance, 8003.61) && near(byId.mbna.pending, 0),
    'MBNA posted $8,003.61 pending $0 matches the screenshot, not the statement $7,855.12');
  ok(near(byId.cashback.balance, 4799.43)
    && near(5612.43 - 50 - 763, 4799.43),
    'Cash Back $4,799.43 = 5,612.43 − $50 − $763');
  ok(byId.cashback.pendingUnknown === true && byId.cashback.pending == null,
    'Cash Back pending is unknown, not a Lunch Money empty-window $0');
  ok(byId.cashback.balance + 0.005 < 5000,
    'Cash Back is under its $5,000 limit on posted');
  ok(Math.abs(5000 - 4799.43 - 200.57) < 0.005,
    'independent posted room is $200.57 — and that is not a known-zero pending reading');
  ok(near(byId.tdcc.balance, 1705.94) && near(1799.97 - 94.03, 1705.94),
    'TD card $1,705.94 = 1,799.97 − the posted $94.03');
  ok(near(byId.travelvisa.balance, 862.68) && near(byId.travelvisa.pending, 250),
    'Travel Visa posted $862.68 + pending Bell $250.00 are distinct');
  ok(near(862.68 + 250 - 1100, 12.68),
    'independent Travel Visa over-limit is $12.68 and is not cash');
}

console.log('\n=== F2. B71 Triangle current-plan path stays under the limit ===');
{
  // Independent ledger, not a second call to projectDebts: opening posted +
  // pending, 21.99%/365 interest, modelled Triangle payment events only.
  // Atlas does not invent future purchases.
  const tri = aug16Pinned.debts.find(d => d.id === 'triangle');
  const obl = aug16Pinned.plan.obligations.find(o => o.id === 'triangle');
  const days = aug16Pinned.plan.windowDays || 91;
  const end = windowEnd(AUG16);
  const LIMIT = 13500;
  const RATE = 21.99;
  const openingUsed = 13197 + 15.62;
  ok(near(tri.balance, 13197) && near(tri.pending, 15.62) && near(tri.limit, LIMIT)
    && near(tri.rate, RATE) && near(obl.amount, 253.57) && obl.firstDue === '2026-09-07'
    && obl.confidence === 'estimated',
    'B91 Triangle opening, limit, rate, and estimated September minimum are unchanged');
  ok(near(LIMIT - openingUsed, 287.38),
    'independent current headroom is $287.38 and is not cash');
  const pays = F.expandEvents(aug16Pinned.plan, AUG16, end, {})
    .filter(e => e.id === 'triangle' && e.kind === 'obligation');
  ok(pays.length === 3 && pays.every(e => e.date >= '2026-09-07')
    && pays.every(e => near(-e.amount, 253.57)),
    'modelled Triangle events are the three estimated $253.57 minima from firstDue',
    pays.map(e => e.date + ':' + (-e.amount)).join(','));
  let bal = openingUsed;
  let interest = 0;
  let paid = 0;
  let firstOver = null;
  let peak = bal;
  let peakDate = AUG16;
  const payOn = new Map(pays.map(e => [e.date, -e.amount]));
  for (let i = 0; i < days; i++) {
    const date = F.addDays(AUG16, i);
    const daily = bal * (RATE / 100) / 365;
    bal += daily;
    interest += daily;
    const take = payOn.get(date);
    if (take) {
      const applied = Math.min(take, bal);
      bal -= applied;
      paid += applied;
    }
    if (firstOver == null && bal > LIMIT) firstOver = { date, balance: bal };
    if (bal > peak) { peak = bal; peakDate = date; }
  }
  const proj = F.projectDebts(aug16Pinned.plan, aug16Pinned.debts, AUG16, Object.assign(liveOpts(), {
    debtHorizonDays: days,
    debts: aug16Pinned.debts,
  }));
  const engine = proj.byId.triangle;
  ok(firstOver == null && engine.firstOver == null,
    'independent walk and Forecast both stay under the $13,500 limit on the current plan',
    firstOver ? firstOver.date : 'no crossing');
  ok(near(engine.opening, openingUsed) && near(engine.balance, bal)
    && near(engine.interest, interest) && near(engine.paid, paid),
    'independent Triangle ledger agrees with projectDebts to the cent',
    `end ${engine.balance.toFixed(4)} vs ${bal.toFixed(4)}`);
  ok(peakDate === '2026-09-06' && peak < LIMIT && near(LIMIT - peak, 111.14),
    'peak is the day before the first modelled payment; $111.14 of headroom remains',
    `${peakDate} ${peak.toFixed(2)} headroom ${(LIMIT - peak).toFixed(2)}`);
  const year = F.projectDebts(aug16Pinned.plan, aug16Pinned.debts, AUG16, Object.assign(liveOpts(), {
    debtHorizonDays: 365,
    debts: aug16Pinned.debts,
  }));
  ok(year.byId.triangle.firstOver == null,
    'the 365-day knowledge-horizon walk also does not cross the Triangle limit');
}

console.log('\n=== G. Amanda / TENNIS INCOME is not spendable; card capacity is not cash ===');
{
  const held = (live.plan.startingCash.heldElsewhere || []).find(r => r.id === AMANDA);
  ok(held && near(held.value, 2691.85),
    'TENNIS INCOME last verified $2,691.85 remains held-elsewhere');
  ok(!near(F.startingCashAmount(live.plan), opening + held.value),
    'held-elsewhere is not inside Forecast opening cash');
  ok(hydroSep && hydroSep.payingAccount === 'chequing-a' && hydroSep.householdObligation === true,
    'Hydro Sept. 1 is a household obligation planned from BILLS ACCOUNT');
  const liveHydroEv = F.expandEvents(live.plan, live.meta.asOf, windowEnd(live.meta.asOf), {})
    .find(e => e.id === 'hydro-due-sep1');
  ok(liveHydroEv && liveHydroEv.jointCash !== false && near(liveHydroEv.amount, -HYDRO_SEP),
    'Hydro Sept. 1 is on the live schedule and reduces joint cash');
  const pinnedHydro = (aug16Pinned.plan.bills || []).find(b => b.id === 'hydro-due-sep1');
  ok(pinnedHydro && pinnedHydro.payingAccount === AMANDA,
    'the 16 Aug pin still records historical TENNIS INCOME Hydro and is not rewritten');
  ok(!hydroNow && !events16.some(e => e.id === 'hydro-due-now' || near(e.amount, -213.79)),
    'the $213.79 / $220 Hydro debit is not scheduled again');
  ok((live.plan.bills || []).some(b => b.id === 'bell' && b.day === 15
      && b.needsDate !== true && b.payingAccount === 'chequing-a' && b.jointCash !== false),
    'Bell exists as the dated BILLS ACCOUNT planning row on the 15th');
  const pinnedUtil = F.utilisation(aug16Pinned.debts, aug16Pinned.revolvingExtra, aug16Pinned.plan);
  const pinnedCash = pinnedUtil.rows.find(r => r.id === 'cashback');
  ok(pinnedUtil.rows.every(r => r.available == null || r.available >= 0),
    'utilisation available figures are non-negative');
  ok(pinnedCash && pinnedCash.pendingUnknown === true && pinnedCash.pending == null
    && pinnedCash.available == null && pinnedCash.overLimit == null,
    'pinned 16 Aug Cash Back posted room is not published as $200.57 available, and over-limit is not closed');
  ok(!pinnedUtil.rows.some(r => r.id === 'cashback' && near(r.available, 200.57)),
    'utilisation does not convert unknown Cash Back pending into $200.57 available');
  ok(!/household cash|spendable/.test(JSON.stringify(pinnedUtil.rows.map(r => r.available))),
    'utilisation does not relabel capacity as cash');
  const pinnedCards = F.resolveFundingSources(
    aug16Pinned.plan.funding && aug16Pinned.plan.funding.options, aug16Pinned.revolvingExtra,
    aug16Pinned.plan, aug16Pinned.debts
  ).find(o => o.id === 'cards');
  ok(pinnedCards && near(pinnedCards.available, 287.38 + 294.06),
    'the unusable cards funding option excludes unknown Cash Back headroom on the 16 Aug pin',
    String(pinnedCards && pinnedCards.available));
  const pinnedAction = F.resolveActions(aug16Pinned.plan, aug16Pinned.debts, aug16Pinned.revolvingExtra)
    .find(a => /Cash Back Visa back under/i.test(a.what));
  ok(pinnedAction && pinnedAction.status === 'open',
    'the Cash Back over-limit action stays open while pending is unknown on the 16 Aug pin');

  const liveCash = live.debts.find(x => x.id === 'cashback');
  ok(liveCash && liveCash.pendingUnknown === false && near(liveCash.pending, 0),
    'live 19 Aug Cash Back pending is the known $0.00 observation, not unknown');
  const liveAction = F.resolveActions(live.plan, live.debts, live.revolvingExtra)
    .find(a => /Cash Back Visa back under/i.test(a.what));
  ok(liveAction && liveAction.status === 'done',
    'live Cash Back under-limit action is Forecast-derived done from known pending');
}

console.log('\n=== H. Q19 is answered; remaining August cash is not a duplicate $814.18 ===');
{
  const heloc = live.plan.obligations.find(o => o.id === 'heloc');
  ok(heloc && heloc.nonCash === true && near(heloc.amount, 814.18),
    'live HELOC remains month-end non-cash capitalisation');
  ok(events16.filter(e => e.id === 'heloc' && e.kind !== 'noncash').length === 0,
    'no HELOC chequing outflow was invented');
  const md = questionsMarkdown();
  ok(/^ANSWERED\b/.test(questionStatus(md, 'Q19')),
    'Q19 is ANSWERED', questionStatus(md, 'Q19'));
  ok(/\$0 additional/i.test(md),
    'the answered question records $0 additional August HELOC cash');
}

console.log('\n=== I. existing Forecast produces the payday plan from the pinned 2026-08-16 opening ===');
{
  const rec = F.recommend(aug16Pinned.plan, AUG16, Object.assign(liveOpts(), {
    debts: aug16Pinned.debts,
    fundingSources: aug16Pinned.plan.funding && aug16Pinned.plan.funding.options,
  }));
  const pinnedOpening = independentSpendable(aug16Pinned.plan);
  ok(pinnedOpening + 0.005 > BUFFER, 'opening cash is above the $500 floor', money(pinnedOpening));
  ok(rec.mode !== 'openingGap',
    'this opening is not an opening-gap plan', rec.mode);
  ok(rec.weekly === null && rec.sim.scheduledAmounts.status === 'unavailable',
    'the pinned opening keeps required-undated source facts and withholds weekly permission');
  ok(!/\$600\s*\/\s*week/.test(JSON.stringify(rec)),
    '$600/week is not encoded as the payday output');
  ok(rec.sim.buffer === BUFFER, 'protected cash floor remains $500');
  ok(rec.nearBoundary && rec.nearBoundary.payday === NEXT_PAY,
    'near-boundary window starts at the next payday from this opening',
    rec.nearBoundary && rec.nearBoundary.payday);
  ok(rec.sim.ending === null,
    'dependent ending cash stays Unknown on the original pinned source facts');
}

console.log('\n=== J. no second forecast/budget engine was introduced ===');
{
  const forecastSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'forecast.js'), 'utf8');
  const reconSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'reconcile.js'), 'utf8');
  ok(/function expandEvents\(plan, start, end, opts\)/.test(forecastSrc),
    'expandEvents remains the Plan schedule expander');
  ok(/function recommend\(plan, asOf, opts\)/.test(forecastSrc),
    'recommend remains the weekly-cap authority');
  ok(!/function paydayEngine|function budgetEngine|function secondForecast/.test(forecastSrc + reconSrc),
    'no second payday or budget engine was added');
  ok(!fs.existsSync(path.join(__dirname, '..', 'public', 'payday.js')),
    'no public/payday.js engine file exists');
  ok(reconSrc.indexOf('NEVER writes data.json') >= 0,
    'reconciler still states it never writes data.json');
}

console.log('\n=== K. observation files remain evidence; reconciler does not write ===');
{
  const before = hashFile(path.join(__dirname, '..', 'data.json'));
  const result = R.reconcile({
    data: live,
    map: require('../docs/reconciliation/balance-map.json'),
    observations: [],
    settlements,
    utility: require('../docs/reconciliation/utility-observations.json'),
    amanda: require('../docs/reconciliation/amanda-income-observations.json'),
    cards,
    posting,
  });
  ok(result.writesCanonicalState === false, 'reconcile result declares no write');
  const campRow = result.rows.find(r => r.observationId === 'payday-fusioncamp-settled');
  const tryRow = result.rows.find(r => r.observationId === 'payday-tryouts-settled');
  const sepRow = result.rows.find(r => r.observationId === 'payday-hydro-due-sep1');
  const nowRow = result.rows.find(r => r.observationId === 'payday-hydro-due-now');
  const pinnedResult = R.reconcile({
    data: aug16Pinned,
    map: require('../docs/reconciliation/balance-map.json'),
    observations: [],
    settlements,
    utility: require('../docs/reconciliation/utility-observations.json'),
    amanda: require('../docs/reconciliation/amanda-income-observations.json'),
    cards,
    posting,
  });
  const triPosted16 = pinnedResult.rows.find(r => r.observationId === 'card-triangle-posted-2026-08-16');
  const mbPosted16 = pinnedResult.rows.find(r => r.observationId === 'card-mbna-posted-2026-08-16');
  const cashPosted16 = pinnedResult.rows.find(r => r.observationId === 'card-cashback-posted-2026-08-16');
  const cashPending16 = pinnedResult.rows.find(r => r.observationId === 'card-cashback-pending-2026-08-16');
  ok(campRow && campRow.status === 'MATCH', 'Fusion camp observation is MATCH against canonical settledOn');
  ok(tryRow && tryRow.status === 'MATCH', 'Fusion tryouts observation is MATCH against canonical settledOn');
  ok(sepRow && sepRow.status === 'MATCH', 'Hydro 1 September observation is MATCH against the live bill');
  ok(nowRow && nowRow.status === 'MISSING', 'Hydro 14 August due remains MISSING — not guessed');
  ok(triPosted16 && triPosted16.status === 'MATCH' && near(triPosted16.evidenceValue, 13197),
    'Aug. 16 Triangle posted observation MATCHES the pinned 2026-08-16 opening');
  ok(mbPosted16 && mbPosted16.status === 'MATCH' && near(mbPosted16.evidenceValue, 8003.61),
    'Aug. 16 MBNA posted observation MATCHES the pinned 2026-08-16 opening');
  ok(cashPosted16 && cashPosted16.status === 'MATCH' && near(cashPosted16.evidenceValue, 4799.43),
    'Aug. 16 Cash Back posted observation MATCHES the pinned 2026-08-16 opening');
  ok(cashPending16 && cashPending16.unknown === true,
    'Aug. 16 Cash Back pending observation stays unknown, not $0');
  ok(result.staleAssigned === false && result.counts.STALE === 0,
    'STALE is still not assigned');
  const out = execFileSync(process.execPath, ['scripts/reconcile.js'], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8',
  });
  ok(hashFile(path.join(__dirname, '..', 'data.json')) === before,
    'running the CLI leaves data.json bytes unchanged');
  ok(/Owner-approved canonical edits remain a separate explicit action/.test(out),
    'the report still says observation files do not write canonical state');
}

console.log('\n=== remaining owner questions stay open ===');
{
  const md = questionsMarkdown();
  ok(/^ANSWERED\b/.test(questionStatus(md, 'Q0')), 'Q0 HOME BUDGET is ANSWERED');
  ok(/^ANSWERED\b/.test(questionStatus(md, 'Q17')), 'Q17 Hydro arrears is ANSWERED');
  ok(/^ANSWERED\b/.test(questionStatus(md, 'Q19')), 'Q19 remaining August HELOC cash is ANSWERED');
  ok(/^ANSWERED\b/.test(questionStatus(md, 'Q23')), 'Q23 Fusion instalments are ANSWERED');
  ok(/^OPEN\b/.test(questionStatus(md, 'Q20')), 'Q20 emergency reserve remains OPEN');
  ok(/^OPEN\b/.test(questionStatus(md, 'Q21')), 'Q21 $527.80 remains OPEN');
  ok(/^OPEN\b/.test(questionStatus(md, 'Q25')), 'Q25 Amanda available remainder remains OPEN');
  ok(/^ANSWERED\b/.test(questionStatus(md, 'Q26')), 'Q26 card pending evidence is ANSWERED');
  ok(/^ANSWERED\b/.test(questionStatus(md, 'Q4')), 'Q4 non-TD balances remain ANSWERED');
  ok(!/Canonical opening remains posted \*\*\$13,497\.00\*\* as of 9 August/.test(md),
    'Q4 does not keep the retired Aug. 9 Triangle $13,497 as the canonical opening');
  ok(!/9 August\s+opening remains posted \*\*\$7,855\.12\*\*/.test(md),
    'Q4 does not keep the retired Aug. 9 MBNA $7,855.12+$82.05 as the canonical opening');
  ok(/Triangle[\s\S]*2026-08-19[\s\S]*\$13,495\.32/.test(md)
    && /MBNA[\s\S]*2026-08-19[\s\S]*\$7,875\.99/.test(md),
    'Q4 records the 2026-08-19 Triangle and MBNA readings as the canonical opening');
  ok(!/not a canonical write/.test(md),
    'Q26 does not call the now-canonical Travel Visa pair a non-write');
  ok(/Travel Visa posted \$862\.68[\s\S]*canonical opening/.test(md)
    && /pending was proven \*\*0\*\*/.test(md)
    && /pendingUnknown` is false/.test(md)
    && /pending is \*\*\$0\.00\*\*/.test(md),
    'Q26 keeps Travel Visa $862.68+$250 as the 16 Aug dated write, records the #106 Cash Back 0 census, and records the 19 Aug owner-authorized known-zero pending');
  const facts = fs.readFileSync(path.join(__dirname, '..', 'docs', 'ACCOUNT_FACTS.md'), 'utf8');
  ok(!/Canonical opening remains posted \*\*\$13,497\.00\*\* \/ pending unknown/.test(facts),
    'ACCOUNT_FACTS does not keep the retired Aug. 9 Triangle $13,497 as the canonical opening');
  ok(/Canonical Forecast opening is the 2026-08-19/.test(facts)
    && /\$13,495\.32/.test(facts),
    'ACCOUNT_FACTS agrees with the live data.json Triangle opening');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
