'use strict';
/* Owner 2026-09-23 Plan Spend roster.
 *
 * Hand literals below are the owner instruction. They are not read back
 * out of Forecast and then used as the expected value. Cash dates for
 * clear months are recomputed here. Seaspan period membership is a
 * 14-day walk from the payroll anchor, not Forecast.seaspanPayPeriodsIntersecting.
 * The historical-to-current allowlists include the separately approved Oct 1
 * team-fee replacement; its exact input and synthetic behavior have their own
 * regression in test-burrards-team-fee-inputs.js.
 *
 * The canonical opening remains 2026-08-19. fusion-household-paid has
 * settledOn 2026-09-10, so that opening still publishes the paid row.
 * The $3,300 remaining is the sum of Forecast's published fusion-household
 * rows once that settlement applies. The roster does not drop a row
 * Forecast still publishes, and it does not add the paid $1,200 on top
 * of a $3,300 sum. Forecast-only: the Plan Spend page and the Forecast
 * card grouping (planSpendCards) were deleted; the rows are proven here.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const F = require('../public/forecast.js');

const ROOT = path.join(__dirname, '..');
const MAIN = '14624c645a7085f132625c3db0455170ffa61133';
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
const periods = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/periods.json'), 'utf8'));
const prior = JSON.parse(execFileSync('git', ['show', `${MAIN}:data.json`], {
  encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
}));

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const cents = n => Math.round(Number(n) * 100);

function utcAdd(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
const HAND_MONTH = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
function independentMonth15(when) {
  if (typeof when !== 'string') return null;
  const match = /^(?:by\s+)?([a-z]+)\s+(\d{4})$/i.exec(when.trim());
  if (!match) return null;
  const month = HAND_MONTH[match[1].toLowerCase()];
  if (!month) return null;
  const year = Number(match[2]);
  if (!Number.isInteger(year) || year < 1000) return null;
  return `${year}-${String(month).padStart(2, '0')}-15`;
}
function independentPaydays(anchor, start, end) {
  let t = anchor;
  while (t > start) t = utcAdd(t, -14);
  const out = [];
  while (t <= end) {
    if (t >= utcAdd(start, -14)) out.push(t);
    t = utcAdd(t, 14);
  }
  return out;
}
function independentPeriodContaining(anchor, date) {
  const paydays = independentPaydays(anchor, utcAdd(date, -28), utcAdd(date, 28));
  for (let i = 0; i < paydays.length; i++) {
    const payday = paydays[i];
    const next = paydays[i + 1] || utcAdd(payday, 14);
    const cycleEnd = utcAdd(next, -1);
    if (payday <= date && date <= cycleEnd) return { payday, nextPayday: next, cycleEnd };
  }
  return null;
}

// provincials: retired by owner decision (Dale, 2026-11-11); it existed on the frozen prior main.
const RETIRED = ['downstairs-couch', 'exterior-painting', 'vehicle-maintenance', 'indio-tournament', 'provincials'];
const FUSION_REMAINING = [
  { id: 'fusion-household-oct', date: '2026-10-31', amount: 1200 },
  { id: 'fusion-household-nov', date: '2026-11-30', amount: 1200 },
  { id: 'fusion-household-dec', date: '2026-12-31', amount: 900 },
];
const FUSION_REMAINING_TOTAL = 1200 + 1200 + 900;
const FUSION_PAID = { id: 'fusion-household-paid', date: '2026-09-10', amount: 1200 };
const OPENING = '2026-08-19';
const AFTER_FUSION_PAID = '2026-09-11';
const TRIP_WINDOW = 'Jan 9\u201310, 2027';

const rows = data.plan.commitments || [];
const byId = Object.fromEntries(rows.map(r => [r.id, r]));
const priorById = Object.fromEntries((prior.plan.commitments || []).map(r => [r.id, r]));

console.log('=== retired commitments are gone from the active plan ===');
for (const id of RETIRED) {
  ok(!byId[id], `${id} is not an active plan.commitments row`);
  ok(priorById[id], `${id} existed on main ${MAIN.slice(0, 7)} before this change`);
}
ok(!rows.some(r => /indio/i.test(`${r.id} ${r.label}`)), 'no active row is named Indio');
ok(!rows.some(r => r.amountMin === 5260 || r.amountMax === 5460 || r.amount === 5260 || r.amount === 5460),
  'no active row still carries the Indio range or its bounds');
const midpoint = (5260 + 5460) / 2;
ok(!rows.some(r => r.amount === midpoint || r.amountMin === midpoint || r.amountMax === midpoint),
  'no active row carries the Indio midpoint');

console.log('\n=== owner amounts and incumbent dates ===');
ok(byId['seattle-nov'] && byId['seattle-nov'].amount === 1500
    && byId['seattle-nov'].date === '2026-11-15'
    && byId['seattle-nov'].when === 'Nov 2026'
    && priorById['seattle-nov'].date === '2026-11-15'
    && priorById['seattle-nov'].amount === 1200,
  'Seattle November is $1,500 on the incumbent 2026-11-15');
ok(independentMonth15('Nov 2026') === '2026-11-15',
  'independent month-15 of Nov 2026 is 2026-11-15');
ok(byId['seattle-dec'] && byId['seattle-dec'].amount === 1500
    && byId['seattle-dec'].date === '2026-12-04'
    && byId['seattle-dec'].when === 'Dec 2026'
    && priorById['seattle-dec'].date === '2026-12-09'
    && priorById['seattle-dec'].amount === 1200,
  'Seattle December is $1,500 on the owner date 2026-12-04 (Dale, 2026-11-21: "December 4th and 5th")');
ok(byId['seattle-dec'].date !== independentMonth15('Dec 2026'),
  'Seattle December keeps its owner day rather than the month-only 15th');
ok(byId['linden-birthday'] && byId['linden-birthday'].amount === 500
    && byId['linden-birthday'].date === '2026-12-09'
    && byId['linden-birthday'].when === 'Dec 2026'
    && byId['linden-birthday'].label === 'Linden birthday'
    && byId['linden-birthday'].payingAccount == null
    && !Object.prototype.hasOwnProperty.call(byId['linden-birthday'], 'payingAccount'),
  'Linden birthday is a $500 ordinary commitment on 2026-12-09 with no payingAccount');
ok(rows.filter(r => r.id === 'linden-birthday').length === 1
    && rows.filter(r => /linden birthday/i.test(`${r.id} ${r.label}`)).length === 1,
  'exactly one Linden birthday commitment row');
ok(byId['seattle-dec'] && byId['linden-birthday']
    && byId['seattle-dec'].id !== byId['linden-birthday'].id
    && byId['seattle-dec'].amount !== byId['linden-birthday'].amount,
  'Linden birthday stays distinct from seattle-dec');
ok(!priorById['linden-birthday'],
  'linden-birthday is new versus the frozen 2026-09-23 prior main');
ok(independentMonth15('timing TBD') == null, 'timing TBD is not a cash date');
ok(byId['san-diego'] && byId['san-diego'].amount === 3000
    && byId['san-diego'].date === '2027-01-09'
    && byId['san-diego'].when === 'Jan 2027'
    && byId['san-diego'].tripWindow === TRIP_WINDOW
    && byId['san-diego'].amountMin == null,
  'San Diego is a $3,000 point on the owner date 2027-01-09 (Dale, 2026-11-21) with the trip window');
ok(byId['san-diego'].date !== independentMonth15('Jan 2027'),
  'San Diego no longer sits on the clear-month 15th (superseded by the owner date)');
for (const hand of FUSION_REMAINING) {
  const row = byId[hand.id];
  ok(row && row.amount === hand.amount && row.date === hand.date && row.group === 'fusion-household',
    `${hand.id} stays a dated $${hand.amount} instalment`);
}
ok(byId[FUSION_PAID.id] && byId[FUSION_PAID.id].amount === 1200
    && byId[FUSION_PAID.id].settledOn === '2026-09-10'
    && byId[FUSION_PAID.id].group === 'fusion-household',
  'the paid Fusion row remains settled history at $1,200 on 2026-09-10');
ok(FUSION_REMAINING.reduce((s, r) => s + r.amount, 0) === 3300
    && FUSION_REMAINING_TOTAL === 3300
    && cents(1200) + cents(1200) + cents(900) === 330000,
  'hand sum of the three remaining Fusion instalments is exactly $3,300');
const fusionGroup = (data.plan.groups || []).find(g => g.id === 'fusion-household');
ok(fusionGroup && fusionGroup.planSpendSummary === true && fusionGroup.label === 'Fusion Lacrosse'
    && fusionGroup.atomic !== true,
  'Fusion Lacrosse is a Plan Spend display group and not an atomic cash event');

console.log('\n=== Forecast cash events: retired rows emit nothing; authorized rows emit once ===');
const HORIZON_END = '2027-08-19';
function commitmentEvents(plan, start, end) {
  return F.expandEvents(plan, start, end, {}).filter(e => e && e.kind === 'commitment');
}
const nowEvents = commitmentEvents(data.plan, OPENING, HORIZON_END);
const priorEvents = commitmentEvents(prior.plan, OPENING, HORIZON_END);
const sig = e => `${e.id}|${e.date}|${e.amount}`;
for (const id of RETIRED) {
  ok(!nowEvents.some(e => e.id === id), `${id} emits no Forecast cash event`);
}
ok(!nowEvents.some(e => /indio/i.test(`${e.id} ${e.label}`)), 'no cash event is named Indio');
ok(!nowEvents.some(e => e.amount === -5260 || e.amount === -5460 || e.amount === -midpoint
    || e.amount === 5260 || e.amount === 5460),
  'no cash event carries an Indio bound or midpoint');
function oneCash(id, date, amount) {
  const hits = nowEvents.filter(e => e.id === id);
  ok(hits.length === 1 && hits[0].date === date && near(hits[0].amount, amount),
    `${id} emits once at ${amount} on ${date}`,
    hits.map(sig).join(', ') || 'missing');
}
oneCash('seattle-nov', '2026-11-15', -1500);
oneCash('seattle-dec', '2026-12-04', -1500);
oneCash('linden-birthday', '2026-12-09', -500);
oneCash('san-diego', '2027-01-09', -3000);
oneCash('burrards-logan-team-fee-oct', '2026-10-16', -202.88);
oneCash('burrards-logan-team-fee-nov', '2026-11-01', -202.87);
oneCash('burrards-linden-team-fee', '2026-10-20', -340);
ok(!nowEvents.some(e => e.id === 'burrards-team-fees'),
  'the replaced aggregate emits no cash event; owner-dated Linden appears once');
ok(!nowEvents.some(e => e.id === 'san-diego' && (e.date === '2027-01-10' || e.date === '2027-01-15')),
  'San Diego emits only on January 9, not also on January 10 or the old 15th');
for (const hand of FUSION_REMAINING) {
  oneCash(hand.id, hand.date, -hand.amount);
}
const paidOnOpening = nowEvents.filter(e => e.id === FUSION_PAID.id);
ok(paidOnOpening.length === 1 && paidOnOpening[0].date === '2026-09-10' && near(paidOnOpening[0].amount, -1200),
  'on the Aug 19 opening Forecast still reserves the paid Fusion instalment on its own date');
const afterPaid = commitmentEvents(data.plan, AFTER_FUSION_PAID, HORIZON_END);
ok(!afterPaid.some(e => e.id === FUSION_PAID.id),
  'from 2026-09-11 the paid Fusion instalment is no longer a cash event');
ok(FUSION_REMAINING.every(hand => afterPaid.some(e => e.id === hand.id && e.date === hand.date && near(e.amount, -hand.amount))),
  'the three remaining Fusion instalments stay individual cash events after settlement');

const nowMap = new Map(nowEvents.map(e => [e.id + '@' + e.date, e.amount]));
const priorMap = new Map(priorEvents.map(e => [e.id + '@' + e.date, e.amount]));
const keys = new Set([...nowMap.keys(), ...priorMap.keys()]);
const cashDeltas = [];
for (const key of keys) {
  const a = priorMap.has(key) ? priorMap.get(key) : null;
  const b = nowMap.has(key) ? nowMap.get(key) : null;
  if (a === b) continue;
  cashDeltas.push(`${key}|${a}->${b}`);
}
cashDeltas.sort();
const expectedDeltas = [
  'box-lacrosse-registration-2027@2027-01-25|null->-750.9',
  'box-lacrosse-team-fees-2027@2027-05-01|null->-800',
  'burrards-linden-team-fee@2026-10-20|null->-340',
  'burrards-logan-team-fee-nov@2026-11-01|null->-202.87',
  'burrards-logan-team-fee-oct@2026-10-16|null->-202.88',
  'burrards-team-fees@2026-09-15|-700->null',
  'christmas-2026@2026-12-25|-3500->-4300',
  'fusion-west-spring-2027@2027-04-06|null->-3600',
  'linden-birthday@2026-12-09|null->-500',
  'san-diego@2027-01-09|null->-3000',
  'seattle-dec@2026-12-04|null->-1500',
  'seattle-dec@2026-12-09|-1200->null',
  'seattle-nov@2026-11-15|-1200->-1500',
];
ok(JSON.stringify(cashDeltas) === JSON.stringify(expectedDeltas),
  'commitment cash events change only for approved input updates',
  cashDeltas.join(' ; ') || 'none');

console.log('\n=== funding sequence and sinking no longer carry the retired rows ===');
function sequenceIds(plan, asOf) {
  return new Set(F.fundingSequence(plan, asOf, {}).map(r => r.id));
}
const seq = sequenceIds(data.plan, OPENING);
const seqAfter = sequenceIds(data.plan, AFTER_FUSION_PAID);
for (const id of RETIRED) ok(!seq.has(id) && !seqAfter.has(id), `${id} is not in the funding sequence`);
ok(seq.has('san-diego') && seqAfter.has('san-diego'), 'San Diego stays in the funding sequence');
ok(!seqAfter.has(FUSION_PAID.id) && FUSION_REMAINING.every(h => seqAfter.has(h.id)),
  'after settlement the sequence keeps the three remaining Fusion rows and drops the paid row');

const sinking = F.budgetBreakdown(data.plan, periods, { paypalPerMonth: data.paypal.perMonth });
const priorSinking = F.budgetBreakdown(prior.plan, periods, { paypalPerMonth: prior.paypal.perMonth });
const sinkLabels = (sinking.sinkingItems || []).map(i => i.label);
ok(!sinkLabels.some(l => /couch|painting|vehicle maintenance|indio/i.test(l)),
  'sinking items do not name couch, painting, vehicle maintenance, or Indio',
  sinkLabels.join(' | '));
ok(sinkLabels.filter(l => l === 'San Diego').length === 1, 'sinking names San Diego once');
const monthsInWindow = (data.plan.windowDays || 91) / (365.25 / 12);
const sinkByLabel = items => {
  const m = new Map();
  for (const item of items || []) m.set(item.label, (m.get(item.label) || 0) + item.amount);
  return m;
};
const sinkNow = sinkByLabel(sinking.sinkingItems);
const sinkPrior = sinkByLabel(priorSinking.sinkingItems);
ok(!sinkNow.has('Seattle tournament #1') && !sinkNow.has('Seattle tournament #2'),
  'the old Seattle tournament sinking labels are gone');
ok(near(sinkNow.get('Seattle November 2026'), 1500 / monthsInWindow)
    && near(sinkNow.get('Seattle December 2026'), 1500 / monthsInWindow)
    && near(sinkPrior.get('Seattle tournament #1'), 1200 / monthsInWindow)
    && near(sinkPrior.get('Seattle tournament #2'), 1200 / monthsInWindow),
  'each Seattle sinking smear is its own point amount over the window');
const sinkingDelta = sinking.sinkingMonthly == null || priorSinking.sinkingMonthly == null
  ? null : sinking.sinkingMonthly - priorSinking.sinkingMonthly;
// Only dated commitments smear into this window's sinking line. The owner
// supplied October 20 for the existing estimated $340 Linden requirement.
// Provincials was retired by owner decision 2026-11-11, so it adds nothing here.
const authorizedSinking = (1500 - 1200) + (1500 - 1200) + 3000 + 500
  + (202.88 + 202.87 - 700) + 340;
ok(priorSinking.sinkingMonthly === null && sinkingDelta === null,
  'the prior required-undated fee withholds its aggregate and any numeric before/after delta');
ok(near(sinkNow.get('Logan Burrards team fee — instalment 1'), 202.88 / monthsInWindow)
    && near(sinkNow.get('Logan Burrards team fee — instalment 2'), 202.87 / monthsInWindow)
    && near(sinkNow.get('Linden Burrards team fee - estimated plan'), 340 / monthsInWindow)
    && !sinkNow.has('Burrards team fees') && !sinkNow.has('Linden Burrards team fee — proposal held'),
  'each dated team fee smears its exact amount; retired and undated rows do not');
ok(near(sinkNow.get('San Diego'), 3000 / monthsInWindow),
  'San Diego sinking smear is the $3,000 point over the window, not a second $3,000');
ok(near(sinkNow.get('Linden birthday'), 500 / monthsInWindow)
    && sinkLabels.filter(l => l === 'Linden birthday').length === 1,
  'sinking names Linden birthday once at the $500 smear');

console.log('\n=== Plan Spend rows published by Forecast.majorPlans ===');
// These historical roster calculations own a fully calculated ledger. A later
// owner-confirmed carried sender must not replace their funding premise with
// an unrelated cash-inclusion hold. Keep canonical source assertions above.
const rosterFundingFixture = JSON.parse(JSON.stringify(data.plan));
delete rosterFundingFixture.obligations.find(row => row.id === 'mbna-aug31').sentPayments;
function plansAt(asOf, plan = rosterFundingFixture) {
  return F.majorPlans(plan, asOf, {
    debts: data.debts,
    periods,
    fundingSources: plan.funding && plan.funding.options,
  });
}
const fusionRows = plans => plans.filter(p => p.group === 'fusion-household');
const openingPlans = plansAt(OPENING);
const settledPlans = plansAt(AFTER_FUSION_PAID);
const openingFusion = fusionRows(openingPlans);
const settledFusion = fusionRows(settledPlans);
ok(openingFusion.map(m => m.id).sort().join(',')
    === ['fusion-household-dec', 'fusion-household-nov', 'fusion-household-oct', 'fusion-household-paid'].sort().join(','),
  'on the Aug 19 opening the Fusion rows are exactly the rows Forecast still publishes');
const openingCents = openingFusion.reduce((s, m) => s + cents(m.need), 0);
ok(openingCents === cents(1200) * 3 + cents(900),
  'Aug 19 Fusion remaining is the cent sum of the four published rows, $4,500');
ok(settledFusion.map(m => m.id).sort().join(',')
    === FUSION_REMAINING.map(r => r.id).sort().join(','),
  'after 2026-09-10 the Fusion rows are only the three remaining instalments');
const settledCents = settledFusion.reduce((s, m) => s + cents(m.need), 0);
ok(settledCents === 330000 && settledCents / 100 === FUSION_REMAINING_TOTAL,
  'after settlement the Fusion rows sum to exactly $3,300');
ok(!settledFusion.some(m => m.id === FUSION_PAID.id) && settledCents !== (3300 + 1200) * 100,
  'the paid $1,200 is not added on top of the $3,300');
const sanRows = settledPlans.filter(c => c.id === 'san-diego');
ok(sanRows.length === 1 && sanRows[0].need === 3000
    && sanRows[0].date === '2027-01-09' && sanRows[0].tripWindow === TRIP_WINDOW,
  'majorPlans has one San Diego row of Forecast need $3,000');
const lindenRows = settledPlans.filter(c => c.id === 'linden-birthday');
ok(lindenRows.length === 1 && lindenRows[0].need === 500
    && lindenRows[0].date === '2026-12-09' && lindenRows[0].label === 'Linden birthday'
    && lindenRows[0].tripWindow == null,
  'majorPlans has one Linden birthday row of Forecast need $500 on 2026-12-09');
const seattleDecRows = settledPlans.filter(c => c.id === 'seattle-dec');
ok(seattleDecRows.length === 1 && seattleDecRows[0].need === 1500
    && seattleDecRows[0].date === '2026-12-04',
  'majorPlans has one seattle-dec row of $1,500 on 2026-12-04');
ok(!settledPlans.some(p => RETIRED.includes(p.id)), 'majorPlans omits every retired id');
const squareRows = settledPlans.filter(c => c.id === 'square-one');
ok(squareRows.length === 1
    && squareRows[0].need === 3131.76 && squareRows[0].date === '2027-02-10'
    && squareRows[0].label === 'Square One home insurance',
  'majorPlans has one Square One row of Forecast need $3,131.76 on 2027-02-10');
ok(!(data.plan.commitments || []).some(c => c.id === 'square-one'
    || /square one|home insurance/i.test(`${c.id} ${c.label}`)),
  'Square One is not a plan.commitments duplicate');
ok(!settledPlans.some(p => p.id === 'amazon-prime' || p.id === 'ultimate-guitar'),
  'monthly card-paid Amazon Prime and yearly joint-cash Ultimate Guitar stay off Plan Spend');

console.log('\n=== Road Ahead Month and Seaspan Pay Period count San Diego once ===');
const anchor = data.plan.income.find(r => r.id === 'payroll').anchor;
ok(anchor === '2026-08-14', 'Seaspan anchor used for the independent walk is 2026-08-14');
const period = independentPeriodContaining(anchor, '2027-01-09');
ok(period && period.payday <= '2027-01-09' && '2027-01-09' <= period.cycleEnd,
  'independent biweekly walk places 2027-01-09 in one Seaspan cycle',
  period && `${period.payday} through ${period.cycleEnd}`);
const oldPeriod = independentPeriodContaining(anchor, '2027-01-15');
ok(oldPeriod && (oldPeriod.payday !== period.payday),
  'the old modeled date (Jan 15) is a different, later Seaspan cycle: San Diego moved one pay period earlier',
  oldPeriod && `${oldPeriod.payday} through ${oldPeriod.cycleEnd}`);
const traj = F.baselineTrajectory(data.plan, data.debts, OPENING, { periods });
ok(traj.status === 'ready', 'baseline trajectory is ready', traj.reason || traj.status);
function commitmentLines(node) {
  const lines = node && node.stage2 && node.stage2.commitments && node.stage2.commitments.lines;
  return Array.isArray(lines) ? lines : [];
}
const jan = (traj.months || []).find(m => m.month === '2027-01');
const janSan = commitmentLines(jan).filter(l => l.id === 'san-diego');
ok(jan && janSan.length === 1 && near(janSan[0].amount, 3000) && janSan[0].date === '2027-01-09',
  'January 2027 Month view contains San Diego $3,000 once',
  janSan.map(l => `${l.date} ${l.amount}`).join(', ') || 'missing');
ok(!(traj.months || []).some(m => m.month !== '2027-01' && commitmentLines(m).some(l => l.id === 'san-diego')),
  'no other month contains San Diego');
ok(!(traj.months || []).some(m => commitmentLines(m).some(l => RETIRED.includes(l.id) || /indio/i.test(`${l.id} ${l.label}`))),
  'no month Road Ahead line is a retired commitment or Indio');
const payHits = (traj.payPeriods || []).filter(p => commitmentLines(p).some(l => l.id === 'san-diego'));
ok(payHits.length === 1, 'exactly one Seaspan pay period contains San Diego',
  payHits.map(p => `${p.payday} ${p.start}–${p.end}`).join(' ; '));
const paySan = commitmentLines(payHits[0]).filter(l => l.id === 'san-diego');
ok(paySan.length === 1 && near(paySan[0].amount, 3000),
  'that pay period contains the same $3,000 once');
ok(payHits[0].payday === period.payday
    && payHits[0].start <= '2027-01-09' && payHits[0].end >= '2027-01-09',
  'that pay period is the independent cycle that contains 2027-01-09',
  payHits[0] && `${payHits[0].payday} ${payHits[0].start}–${payHits[0].end} vs ${period.payday}–${period.cycleEnd}`);
const nov = (traj.months || []).find(m => m.month === '2026-11');
const dec = (traj.months || []).find(m => m.month === '2026-12');
ok(commitmentLines(nov).some(l => l.id === 'seattle-nov' && near(l.amount, 1500) && l.date === '2026-11-15'),
  'November Month view contains Seattle November $1,500 on Nov 15');
ok(commitmentLines(dec).some(l => l.id === 'seattle-dec' && near(l.amount, 1500) && l.date === '2026-12-04'),
  'December Month view contains Seattle December $1,500 on Dec 4');
ok(commitmentLines(dec).filter(l => l.id === 'linden-birthday').length === 1
    && commitmentLines(dec).some(l => l.id === 'linden-birthday' && near(l.amount, 500) && l.date === '2026-12-09'),
  'December Month view contains Linden birthday $500 once on Dec 9');
ok(commitmentLines(dec).filter(l => l.id === 'seattle-dec').length === 1,
  'December Month view still contains seattle-dec once');
ok(!(traj.months || []).some(m => m.month !== '2026-12' && commitmentLines(m).some(l => l.id === 'linden-birthday')),
  'no other month contains Linden birthday');
const lindenPeriod = independentPeriodContaining(anchor, '2026-12-09');
ok(lindenPeriod && lindenPeriod.payday <= '2026-12-09' && '2026-12-09' <= lindenPeriod.cycleEnd,
  'independent biweekly walk places 2026-12-09 in one Seaspan cycle',
  lindenPeriod && `${lindenPeriod.payday} through ${lindenPeriod.cycleEnd}`);
const lindenPayHits = (traj.payPeriods || []).filter(p => commitmentLines(p).some(l => l.id === 'linden-birthday'));
ok(lindenPayHits.length === 1, 'exactly one Seaspan pay period contains Linden birthday',
  lindenPayHits.map(p => `${p.payday} ${p.start}–${p.end}`).join(' ; '));
const payLinden = commitmentLines(lindenPayHits[0]).filter(l => l.id === 'linden-birthday');
ok(payLinden.length === 1 && near(payLinden[0].amount, 500) && payLinden[0].date === '2026-12-09',
  'that pay period contains Linden birthday $500 once');
ok(commitmentLines(lindenPayHits[0]).some(l => l.id === 'seattle-dec' && near(l.amount, 1500)),
  'the pay period starting Dec 4 holds both seattle-dec $1,500 (Dec 4) and Linden (Dec 9)');
ok(lindenPayHits[0].payday === lindenPeriod.payday
    && lindenPayHits[0].start <= '2026-12-09' && lindenPayHits[0].end >= '2026-12-09',
  'that pay period is the independent cycle that contains 2026-12-09',
  lindenPayHits[0] && `${lindenPayHits[0].payday} ${lindenPayHits[0].start}–${lindenPayHits[0].end} vs ${lindenPeriod.payday}–${lindenPeriod.cycleEnd}`);
const feb = (traj.months || []).find(m => m.month === '2027-02');
const febSq = commitmentLines(feb).filter(l => l.id === 'square-one');
ok(feb && febSq.length === 1 && near(febSq[0].amount, 3131.76) && febSq[0].date === '2027-02-10',
  'February 2027 Month view contains Square One $3,131.76 once',
  febSq.map(l => `${l.date} ${l.amount}`).join(', ') || 'missing');
ok(!(traj.months || []).some(m => m.month !== '2027-02' && commitmentLines(m).some(l => l.id === 'square-one')),
  'no other month contains Square One');
const squarePeriod = independentPeriodContaining(anchor, '2027-02-10');
ok(squarePeriod && squarePeriod.payday <= '2027-02-10' && '2027-02-10' <= squarePeriod.cycleEnd,
  'independent biweekly walk places 2027-02-10 in one Seaspan cycle',
  squarePeriod && `${squarePeriod.payday} through ${squarePeriod.cycleEnd}`);
const squarePayHits = (traj.payPeriods || []).filter(p => commitmentLines(p).some(l => l.id === 'square-one'));
ok(squarePayHits.length === 1, 'exactly one Seaspan pay period contains Square One',
  squarePayHits.map(p => `${p.payday} ${p.start}–${p.end}`).join(' ; '));
const paySquare = commitmentLines(squarePayHits[0]).filter(l => l.id === 'square-one');
ok(paySquare.length === 1 && near(paySquare[0].amount, 3131.76) && paySquare[0].date === '2027-02-10',
  'that pay period contains Square One $3,131.76 once');
ok(squarePayHits[0].payday === squarePeriod.payday
    && squarePayHits[0].start <= '2027-02-10' && squarePayHits[0].end >= '2027-02-10',
  'that pay period is the independent cycle that contains 2027-02-10',
  squarePayHits[0] && `${squarePayHits[0].payday} ${squarePayHits[0].start}–${squarePayHits[0].end} vs ${squarePeriod.payday}–${squarePeriod.cycleEnd}`);
const fusionMonthAmounts = [];
for (const month of traj.months || []) {
  for (const line of commitmentLines(month)) {
    if (/^fusion-household-/.test(line.id)) fusionMonthAmounts.push(`${month.month}|${line.id}|${line.amount}|${line.date}`);
  }
}
const expectedFusionMonths = [
  '2026-09|fusion-household-paid|1200|2026-09-10',
  '2026-10|fusion-household-oct|1200|2026-10-31',
  '2026-11|fusion-household-nov|1200|2026-11-30',
  '2026-12|fusion-household-dec|900|2026-12-31',
];
ok(JSON.stringify(fusionMonthAmounts.sort()) === JSON.stringify(expectedFusionMonths.sort()),
  'Road Ahead still uses the individual Fusion dates, including the paid row only while this opening reserves it',
  fusionMonthAmounts.join(' ; '));

const priorTraj = F.baselineTrajectory(prior.plan, prior.debts, OPENING, { periods });
ok(priorTraj.status === 'unavailable', 'the original prior trajectory explicitly withholds its dependent projection');
const priorScheduled = F.scheduledAmountState(prior.plan, OPENING, HORIZON_END);
ok(JSON.stringify(priorScheduled.unknowns.filter(row => row.dateUnknown).map(row => row.id).sort())
  === JSON.stringify(['downstairs-couch', 'exterior-painting', 'provincials', 'vehicle-maintenance']),
  'the prior dependency hold names its exact original required-undated source records');
function lineMap(trajectory) {
  const map = new Map();
  for (const month of trajectory.months || []) {
    for (const line of commitmentLines(month)) {
      map.set(`${month.month}|${line.id}|${line.date || ''}`, line.amount);
    }
  }
  return map;
}
const lineNow = lineMap(traj);
const linePrior = lineMap(priorTraj);
const lineKeys = new Set([...lineNow.keys(), ...linePrior.keys()]);
const lineDeltas = [];
for (const key of lineKeys) {
  const a = linePrior.has(key) ? linePrior.get(key) : null;
  const b = lineNow.has(key) ? lineNow.get(key) : null;
  if (a === b || (a != null && b != null && near(a, b))) continue;
  lineDeltas.push(`${key}|${a}->${b}`);
}
lineDeltas.sort();
const expectedLineDeltas = [
  '2026-09|burrards-team-fees|2026-09-15|700->null',
  '2026-10|burrards-linden-team-fee|2026-10-20|null->340',
  '2026-10|burrards-logan-team-fee-oct|2026-10-16|null->202.88',
  '2026-11|burrards-logan-team-fee-nov|2026-11-01|null->202.87',
  '2026-11|seattle-nov|2026-11-15|1200->1500',
  '2026-12|linden-birthday|2026-12-09|null->500',
  '2026-12|seattle-dec|2026-12-04|null->1500',
  '2026-12|seattle-dec|2026-12-09|1200->null',
  '2027-01|san-diego|2027-01-09|null->3000',
  '2027-07|propertytax|2027-07-01|null->6000',
];
const authorizedLineKeys = new Set();
for (const expected of expectedLineDeltas) {
  const split = expected.lastIndexOf('|'), key = expected.slice(0, split);
  const [before, after] = expected.slice(split + 1).split('->');
  authorizedLineKeys.add(key);
  ok((lineNow.has(key) ? lineNow.get(key) : null) === (after === 'null' ? null : Number(after)),
    'approved current Road Ahead line preserves its exact source amount and date: ' + key);
  const old = linePrior.has(key) ? linePrior.get(key) : null;
  ok(old === null || old === (before === 'null' ? null : Number(before)),
    'prior line is its source amount or explicitly withheld: ' + key);
}
for (const key of lineKeys) {
  if (authorizedLineKeys.has(key)) continue;
  const a = linePrior.has(key) ? linePrior.get(key) : null, b = lineNow.has(key) ? lineNow.get(key) : null;
  if (a === b) continue;
  const id = key.split('|')[1], source = data.plan.commitments.find(row => row.id === id) || data.plan.bills.find(row => row.id === id);
  ok(a === null && source && b === source.amount
    && priorScheduled.status === 'unavailable',
    'an unchanged source line can become known only from the prior dependency hold: ' + key);
}

const midNovember = '2026-11-15';
// This grouped-verdict fixture owns a fully calculated funding state. Later
// incumbent statement/sender records must not inject an unrelated evidence
// hold into its FUNDING GAP + ON TRACK severity proof.
const groupingFixture = JSON.parse(JSON.stringify(data.plan));
for (const row of groupingFixture.obligations || []) {
  delete row.statementOccurrences;
  delete row.sentPayments;
}
const midNovPlans = plansAt(midNovember, groupingFixture);
const midNovMembers = midNovPlans.filter(p => p.group === 'fusion-household');
// The whole Fusion season was owner-confirmed paid, settledOn 2026-11-02 (confirmation date, not a payment date
// on all three instalments), so by mid-November the settled rows are history:
// Forecast publishes no Fusion members. Before that settlement this vantage
// published a FUNDING GAP October row beside ON TRACK instalments.
ok(midNovMembers.length === 0,
  'on 2026-11-15 Forecast publishes no Fusion members: the whole season settled (settledOn 2026-11-02)');

// Independent invented sender-only evidence must still withhold member
// verdicts. Removing the unrelated evidence from the grouping
// fixture above is not permission to publish a verdict on an unknown ledger.
const heldFixture = JSON.parse(JSON.stringify(groupingFixture));
// The withholding proof needs published Fusion members. The season's
// 2026-11-02 settlement is a data fact proven elsewhere; strip settledOn in
// this fixture only so the members publish and what is measured here is the
// unknown-ledger behaviour, not the settlement.
for (const row of heldFixture.commitments || []) {
  if (/^fusion-household-(oct|nov|dec)$/.test(row.id)) delete row.settledOn;
}
heldFixture.obligations = heldFixture.obligations.filter(row => row.debtId !== 'triangle');
heldFixture.obligations.push({ id: 'invented-held-minimum', label: 'Invented minimum',
  debtId: 'triangle', effect: 'payment', frequency: 'monthly', day: 7,
  firstDue: '2035-10-07', amount: 43.21, confidence: 'estimated', payingAccount: 'chequing-a',
  statementOccurrences: [{ scheduledDate: '2035-10-07', dueDate: '2035-10-09',
    minimum: 47.39, currency: 'cad', confidence: 'confirmed' }],
  sentPayments: [{ scheduledDate: '2035-10-07', confirmed: true, intent: 'minimum',
    debitId: 'invented-roster-send', postedOn: '2035-10-03', amount: 52.67,
    currency: 'cad', fundingAccountId: 'chequing-a', pending: false }],
});
const heldMembers = plansAt('2035-11-15', heldFixture);
const heldFusion = heldMembers.filter(row => row.group === 'fusion-household');
ok(heldFusion.length === 3 && heldFusion.every(row => row.verdict == null && row.remaining == null),
  'invented sender-only uncertainty withholds all grouped member funding claims after the due cycle');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
