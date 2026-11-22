'use strict';
/* A dated commitment whose valid settledOn is on or before the CURRENT
 * Forecast opening must not be reintroduced into current/future
 * trajectory funding merely because a live overlay named an earlier
 * priorAsOf. Recurring joint-cash bills in that lookback belong
 * to their own pay periods. Historical openings before settledOn still reserve.
 *
 * Independent of carriedUnresolvedJointCashOutflows: settlement is
 * YYYY-MM-DD comparison against the Forecast opening, then event
 * lists and with/without-row stage2 deltas.
 * `node test/test-settled-commitment-priorasof.js`
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, tol = 0.005) => Math.abs(Number(a) - Number(b)) <= tol;
const clone = x => JSON.parse(JSON.stringify(x));
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));

const liveHash = hashFile(DATA);

const SETTLED_ON = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
function independentlySettledOn(c) {
  const d = c && c.settledOn;
  return typeof d === 'string' && SETTLED_ON.test(d) ? d : null;
}
function independentlySettledBy(c, start) {
  const d = independentlySettledOn(c);
  return !!(d && typeof start === 'string' && SETTLED_ON.test(start) && d <= start);
}
function independentlyOptional(c) {
  if (!c) return false;
  if (c.flexibility === 'optional' || c.optional === true) return true;
  return false;
}
function independentlyPointAmount(c) {
  if (!c || c.amount == null || !isFinite(Number(c.amount))) return null;
  return Number(c.amount);
}
// Second method: a point commitment funds a span only when it is not
// settled by the CURRENT opening, and either its scheduled date is in
// the future window or it is an unresolved carry in (priorAsOf, opening)
// applied at the opening. This is not expandEvents and not the carry helper.
function independentlyAppliesInSpan(c, opening, prior, spanStart, spanEnd) {
  const amount = independentlyPointAmount(c);
  if (amount == null || !c.date) return false;
  if (independentlyOptional(c)) return false;
  if (independentlySettledBy(c, opening)) return false;
  const inFuture = c.date >= opening && c.date <= spanEnd;
  const inCarry = !!(prior && prior < opening && c.date > prior && c.date < opening);
  if (!inFuture && !inCarry) return false;
  const apply = inCarry ? opening : c.date;
  return apply >= spanStart && apply <= spanEnd;
}
function independentlySpanCommitmentTotal(commitments, opening, prior, spanStart, spanEnd) {
  let sum = 0;
  for (const c of commitments || []) {
    if (independentlyAppliesInSpan(c, opening, prior, spanStart, spanEnd)) {
      sum += independentlyPointAmount(c);
    }
  }
  return Math.round(sum * 100) / 100;
}

const PRIOR = '2026-08-19';
const OPENING = '2026-09-17';
const SETTLED_DATE = '2026-09-10';
const HISTORICAL = '2026-09-09';
const WINDOW_END = F.addDays(OPENING, 90);
const SETTLED_AMT = 400;
const SIBLING_AMT = 60;
const GROUP_UNSETTLED_AMT = 250;
const UNSETTLED_CARRY_AMT = 175;
const BILL_AMT = 85;
const FUTURE_AMT = 90;

function syntheticPlan() {
  return {
    windowDays: 91,
    startingCash: { amount: 5000 },
    defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
    opening: { asOf: OPENING, priorAsOf: PRIOR, representedEvents: [] },
    budget: {
      basis: 'ytd',
      categories: [{
        id: 'groceries', label: 'Groceries', class: 'essential',
        from: ['Groceries'], plannedWeekly: 100,
      }],
    },
    income: [{
      id: 'payroll', label: 'Synthetic payroll',
      frequency: 'biweekly', anchor: '2026-08-14',
      amount: 2000, confidence: 'confirmed',
    }],
    obligations: [],
    bills: [{
      id: 'recurring-joint-cash',
      label: 'Synthetic recurring joint-cash bill',
      frequency: 'monthly',
      day: 20,
      amount: BILL_AMT,
      confidence: 'confirmed',
      budgetCategory: 'household',
    }],
    commitments: [
      {
        id: 'settled-once',
        date: SETTLED_DATE,
        label: 'Settled once commitment',
        amount: SETTLED_AMT,
        settledOn: SETTLED_DATE,
        group: 'synthetic-group',
        confidence: 'confirmed',
      },
      {
        id: 'same-day-sibling',
        date: SETTLED_DATE,
        label: 'Unsettled same-day sibling',
        amount: SIBLING_AMT,
        group: 'other-group',
        confidence: 'confirmed',
      },
      {
        id: 'group-unsettled',
        date: '2026-10-15',
        label: 'Unsettled same-group sibling',
        amount: GROUP_UNSETTLED_AMT,
        group: 'synthetic-group',
        confidence: 'estimated',
      },
      {
        id: 'unsettled-carry',
        date: '2026-09-05',
        label: 'Unsettled dated carry',
        amount: UNSETTLED_CARRY_AMT,
        confidence: 'confirmed',
      },
      {
        id: 'future-unsettled',
        date: '2026-09-20',
        label: 'Future unsettled after opening',
        amount: FUTURE_AMT,
        confidence: 'confirmed',
      },
    ],
  };
}

function periodsFixture() {
  return {
    periods: {
      ytd: {
        label: 'YTD fixture',
        months: 1,
        spending: [{ label: 'Groceries', total: 40000 }],
      },
    },
  };
}

function liveOverlayPlan() {
  const live = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const plan = clone(live.plan);
  // This earlier commitment ledger owns its calculated opening; unrelated
  // later carried-card sender evidence must not introduce a funding hold.
  delete plan.obligations.find(row => row.id === 'mbna-aug31').sentPayments;
  plan.opening = Object.assign({}, plan.opening, {
    asOf: OPENING,
    priorAsOf: PRIOR,
  });
  return { live, plan };
}

console.log('=== 1. Carry helper settles commitments against the current opening ===');
{
  const src = read('public/forecast.js');
  const start = src.indexOf('function carriedUnresolvedJointCashOutflows(');
  const end = src.indexOf('function streamAmount(', start);
  const body = start >= 0 && end > start ? src.slice(start, end) : '';
  ok(start >= 0 && end > start, 'carriedUnresolvedJointCashOutflows is defined');
  ok(/commitmentSettledBy\(row, start\)/.test(body),
    'carry path uses commitmentSettledBy against the current Forecast opening');
  ok(!/fusion-household-paid/.test(body) && !/1200/.test(body),
    'carry path does not special-case Fusion id or $1,200');
  ok(!/representedEvents/.test(body)
    || /Represented names are omitted/.test(body),
    'carry path still omits represented names; it is not a second settlement engine');
}

console.log('\n=== 2. Synthetic: settled commitment is not carried; history and siblings hold ===');
{
  const plan = syntheticPlan();
  const settled = plan.commitments.find(c => c.id === 'settled-once');
  ok(independentlySettledBy(settled, OPENING) === true
    && independentlySettledBy(settled, HISTORICAL) === false
    && independentlySettledBy(settled, F.addDays(PRIOR, 1)) === false,
    'independent YYYY-MM-DD: settled by current opening, not by historical or prior+1');

  const events = F.expandEvents(plan, OPENING, WINDOW_END, {});
  ok(!events.some(e => e.id === 'settled-once'),
    'current opening with priorAsOf does not emit the settled commitment');
  ok(events.some(e => e.id === 'same-day-sibling' && e.date === SETTLED_DATE
      && near(e.amount, -SIBLING_AMT)),
    'same-day unsettled sibling still fires — not a date-wide skip');
  ok(events.some(e => e.id === 'group-unsettled' && near(e.amount, -GROUP_UNSETTLED_AMT)),
    'unsettled same-group sibling still fires — not a group-wide skip');
  ok(events.some(e => e.id === 'unsettled-carry' && e.date === '2026-09-05'
      && near(e.amount, -UNSETTLED_CARRY_AMT)),
    'unsettled dated commitment in the priorAsOf lookback remains reserved');
  ok(events.some(e => e.id === 'future-unsettled' && e.date === '2026-09-20'
      && near(e.amount, -FUTURE_AMT)),
    'unsettled commitment after the opening still funds the walk');
  ok(!events.some(e => e.id === 'recurring-joint-cash' && e.date === '2026-08-20'),
    'a recurring bill due in the closed period is absent from the current walk');
  ok(events.filter(e => e.id === 'recurring-joint-cash' && e.date === '2026-09-20').length === 1,
    'the next recurring occurrence after the opening is still scheduled once');

  const historical = clone(plan);
  historical.opening = { asOf: HISTORICAL, priorAsOf: PRIOR, representedEvents: [] };
  const histEvents = F.expandEvents(historical, HISTORICAL, F.addDays(HISTORICAL, 90), {});
  ok(histEvents.some(e => e.id === 'settled-once' && e.date === SETTLED_DATE
      && near(e.amount, -SETTLED_AMT)),
    'historical opening before settledOn still reserves the same commitment');

  const noPrior = clone(plan);
  noPrior.opening = { asOf: OPENING, representedEvents: [] };
  const noPriorEvents = F.expandEvents(noPrior, OPENING, WINDOW_END, {});
  ok(!noPriorEvents.some(e => e.id === 'settled-once'),
    'without priorAsOf the settled row is still omitted by opening-relative settlement');
  ok(!noPriorEvents.some(e => e.id === 'recurring-joint-cash' && e.date === '2026-08-20'),
    'without priorAsOf the same closed-period occurrence is also absent');
}

console.log('\n=== 3. Synthetic trajectory: settled row contributes $0 to current funding ===');
{
  const plan = syntheticPlan();
  const traj = F.baselineTrajectory(plan, [], OPENING, { periods: periodsFixture() });
  ok(traj.status === 'ready', 'synthetic trajectory is ready');
  const sep = (traj.months || []).find(m => m.month === '2026-09');
  ok(sep && sep.stage2 && sep.stage2.commitments, 'September month publishes stage2');

  const independentSep = independentlySpanCommitmentTotal(
    plan.commitments, OPENING, PRIOR, '2026-09-01', '2026-09-30');
  ok(near(independentSep, SIBLING_AMT + UNSETTLED_CARRY_AMT + FUTURE_AMT),
    'independent September reserved commitments are sibling + carry + future, not the settled row',
    String(independentSep));
  ok(near(sep.stage2.commitments.amount, independentSep),
    'published September stage2 commitments match that independent sum',
    String(sep.stage2.commitments.amount));

  const withoutSettled = clone(plan);
  withoutSettled.commitments = withoutSettled.commitments.filter(c => c.id !== 'settled-once');
  const trajWithout = F.baselineTrajectory(withoutSettled, [], OPENING, {
    periods: periodsFixture(),
  });
  const sepWithout = (trajWithout.months || []).find(m => m.month === '2026-09');
  const delta = Number(sepWithout.stage2.result.amount) - Number(sep.stage2.result.amount);
  ok(near(delta, 0),
    'removing only the settled commitment changes September stage2 result by $0',
    String(delta));
}

console.log('\n=== 4. Live overlay: fusion-household-paid does not re-fund after 2026-09-10 ===');
{
  const { live, plan } = liveOverlayPlan();
  const row = (plan.commitments || []).find(c => c.id === 'fusion-household-paid');
  const OWNER_PAID = 1200;
  ok(row && near(row.amount, OWNER_PAID) && independentlySettledOn(row) === SETTLED_DATE,
    'canonical paid Fusion row is $1,200 settledOn 2026-09-10');
  ok(independentlySettledBy(row, OPENING) === true
    && independentlySettledBy(row, HISTORICAL) === false,
    'independent settlement: reserved before 2026-09-10, satisfied on a Sep 17 opening');

  const horizon = F.knowledgeHorizon(plan, OPENING);
  const events = F.expandEvents(plan, OPENING, horizon.end, {});
  const fusionHits = events.filter(e => e.id === 'fusion-household-paid');
  ok(fusionHits.length === 0,
    'live Sep 17 opening with priorAsOf 2026-08-19 emits no fusion-household-paid cash event');
  const fusionCash = fusionHits.reduce((s, e) => s + (-Number(e.amount) || 0), 0);
  ok(near(fusionCash, 0),
    'fusion-household-paid contributes $0 to current/future expandEvents funding');

  ok(events.some(e => e.id === 'fusion-household-oct' && e.date === '2026-10-31'),
    'later Fusion instalment is not group-suppressed');
  ok(events.some(e => e.id === 'fusion-household-nov'),
    'November Fusion instalment still funds after the paid row settles');
  ok(events.some(e => e.id === 'fusion-household-dec'),
    'December Fusion instalment still funds after the paid row settles');

  const periods = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/periods.json'), 'utf8'));
  const traj = F.baselineTrajectory(plan, live.debts, OPENING, {
    periods,
    extraFacilities: live.revolvingExtra,
  });
  ok(traj.status === 'ready', 'live overlay trajectory is ready');
  const sep = (traj.months || []).find(m => m.month === '2026-09');
  ok(sep && sep.stage2 && sep.stage2.commitments, 'September month publishes stage2');

  const independentSep = independentlySpanCommitmentTotal(
    plan.commitments, OPENING, PRIOR, '2026-09-01', '2026-09-30');
  ok(near(sep.stage2.commitments.amount, independentSep),
    'live September stage2 commitments match independent reserved-point sum',
    `${sep.stage2.commitments.amount} vs ${independentSep}`);
  ok(!independentlyAppliesInSpan(row, OPENING, PRIOR, '2026-09-01', '2026-09-30'),
    'independent method excludes fusion-household-paid from September funding');

  const without = clone(plan);
  without.commitments = without.commitments.filter(c => c.id !== 'fusion-household-paid');
  const trajWithout = F.baselineTrajectory(without, live.debts, OPENING, {
    periods,
    extraFacilities: live.revolvingExtra,
  });
  const sepWithout = (trajWithout.months || []).find(m => m.month === '2026-09');
  const monthDelta = Number(sepWithout.stage2.result.amount) - Number(sep.stage2.result.amount);
  ok(near(monthDelta, 0),
    'removing only fusion-household-paid changes September stage2 result by $0 (was +$1,200 on main)',
    String(monthDelta));

  const pay = (traj.payPeriods || []).find(p => p.start === OPENING && p.end === '2026-09-24')
    || (traj.payPeriods || []).find(p => OPENING >= p.start && OPENING <= p.end);
  ok(pay && pay.start && pay.end, 'Sep 17 opening publishes a pay-period view');
  ok(pay.start === OPENING && pay.end === '2026-09-24',
    'published pay period is the walk-clipped Sep 17–24 span',
    `${pay.start}–${pay.end}`);
  const independentPay = independentlySpanCommitmentTotal(
    plan.commitments, OPENING, PRIOR, pay.start, pay.end);
  ok(near(pay.stage2.commitments.amount, independentPay),
    'Sep 17–24 stage2 commitments match independent reserved-point sum',
    String(pay.stage2.commitments.amount));
  ok(near(independentPay, 0) || !independentlyAppliesInSpan(row, OPENING, PRIOR, pay.start, pay.end),
    'settled Fusion is not in the independent Sep 17–24 commitment total');
  const payWithout = (trajWithout.payPeriods || [])
    .find(p => p.start === pay.start && p.end === pay.end);
  const payDelta = Number(payWithout.stage2.result.amount) - Number(pay.stage2.result.amount);
  ok(near(payDelta, 0),
    'removing only fusion-household-paid changes Sep 17–24 stage2 result by $0',
    String(payDelta));

  const historical = clone(live.plan);
  historical.opening = Object.assign({}, historical.opening, {
    asOf: HISTORICAL,
    priorAsOf: PRIOR,
  });
  const histEvents = F.expandEvents(historical, HISTORICAL, F.addDays(HISTORICAL, 90), {});
  ok(histEvents.some(e => e.id === 'fusion-household-paid' && e.date === SETTLED_DATE
      && near(e.amount, -OWNER_PAID)),
    'historical opening before 2026-09-10 still reserves fusion-household-paid');

  const dated = clone(live.plan);
  const datedAsOf = dated.opening && dated.opening.asOf;
  ok(datedAsOf && datedAsOf < SETTLED_DATE,
    'canonical dated opening is still before Fusion settlement');
  const datedEvents = F.expandEvents(dated, datedAsOf, F.addDays(datedAsOf, 90), {});
  ok(datedEvents.some(e => e.id === 'fusion-household-paid' && near(e.amount, -OWNER_PAID)),
    'canonical dated opening still reserves the paid Fusion row until its settledOn');
}

console.log('\n=== 5. Live document is unread for mutation ===');
ok(hashFile(DATA) === liveHash, 'data.json is unchanged');

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nSettled-commitment priorAsOf checks passed.');
