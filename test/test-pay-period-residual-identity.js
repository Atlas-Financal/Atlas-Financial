'use strict';
/* Forecast remaining-through-next-payday vs Budget This Pay Period.
 *
 * Adversarial case: a Seaspan cycle has already started, as-of is mid-cycle,
 * Forecast publishes only the remaining window. Those two date windows must
 * not share Budget's "This Pay Period" identity. Figures stay the clipped
 * walk; this is identity/presentation, not a retarget of payday math.
 *
 * `node test/test-pay-period-residual-identity.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, tol = 0.005) => Math.abs(Number(a) - Number(b)) <= tol;

const AS_OF = '2026-09-19';
const PAYDAY = '2026-09-11';
const CYCLE_END = '2026-09-24';
const NEXT_PAYDAY = '2026-09-25';
const ONCE_DUE = '2026-09-15';
const ONCE_AMT = 199;
const PAYROLL_AMT = 4000;
const GROCERIES_WEEKLY = 140;
const CALENDAR_MONTH_DAYS = 365.25 / 12;
const WEEKS_PER_MONTH = CALENDAR_MONTH_DAYS / 7;

function addDays(date, n) {
  const [y, m, d] = String(date).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
function roundCent(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
function periodFromPayday(payday) {
  const next = addDays(payday, 14);
  return { start: payday, end: addDays(next, -1), nextPayday: next };
}
function periodsFixture() {
  return {
    periods: {
      ytd: {
        label: 'YTD fixture',
        months: 1,
        spending: [{ label: 'Groceries', total: 50000 }],
      },
    },
  };
}

function fixture() {
  const plan = {
    windowDays: 91,
    defaults: { targetBuffer: 500, extraDebtMonthly: 0, scenario: 'expected' },
    startingCash: {
      breakdown: [{
        id: 'chequing-a', label: 'BILLS ACCOUNT', value: 2000, class: 'spendable',
      }],
    },
    opening: { asOf: AS_OF },
    nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
    payrollPlanningAssumptions: {
      raiseFactor: 1.04, bonusRate: 0.18, authorizedThroughYear: 2027,
    },
    income: [{
      id: 'payroll', label: 'Payroll — Seaspan',
      frequency: 'biweekly', anchor: '2026-08-14',
      amount: PAYROLL_AMT, confidence: 'confirmed',
    }],
    obligations: [],
    bills: [{
      id: 'once-hydro', label: 'Once hydro', frequency: 'once',
      date: ONCE_DUE, amount: ONCE_AMT, confidence: 'confirmed',
      payingAccount: 'chequing-a',
    }],
    commitments: [],
    budget: {
      categories: [{
        id: 'groceries', label: 'Groceries', class: 'essential',
        plannedWeekly: GROCERIES_WEEKLY,
      }],
    },
  };
  const debts = [];
  return { plan, debts };
}

function independentWeekly(plan) {
  const bd = F.budgetBreakdown(plan, periodsFixture(), { asOf: AS_OF });
  const plannedMonthly = (bd.categories || [])
    .filter(c => c && c.class !== 'reserve' && c.source !== 'historical-actual')
    .reduce((s, c) => s + (Number(c.planned) || 0), 0);
  return roundCent(plannedMonthly / WEEKS_PER_MONTH);
}

function loadPlanning() {
  const appSrc = read('public/app.js');
  const grab = re => {
    const m = re.exec(appSrc);
    if (!m) throw new Error('missing ' + re);
    return m[0];
  };
  const helpers = [
    grab(/^const money = .*$/m), grab(/^const money2 = .*$/m), grab(/^const pct = .*$/m),
    grab(/^const fmtDate = .*$/m), grab(/^const fmtDateLong = .*$/m), grab(/^const fmtDateFull = .*$/m),
  ].join('\n');
  const elements = {};
  const ctx = {
    Forecast: F, console, elements,
    App: {
      hooks: [], bootOpts: null,
      register(fn) { this.hooks.push(fn); },
      boot(opts) { this.bootOpts = opts || {}; },
    },
  };
  vm.runInNewContext(
    `${helpers}\nfunction planningStubEl(){ const attrs = {}; return { innerHTML: '', textContent: '', querySelector(){return null;}, querySelectorAll(){return [];}, classList:{toggle(){},add(){},remove(){}}, setAttribute(k,v){ attrs[k]=v; }, getAttribute(k){ return attrs[k] != null ? attrs[k] : null; } }; }\nconst $ = id => elements[id] || (elements[id] = planningStubEl());\n${read('public/planning.js')}`,
    ctx, { filename: 'public/planning.js' });
  return ctx;
}

function budgetHead(period) {
  return `${period.label}${period.rangeLabel ? ` · ${period.rangeLabel}` : ''}`;
}

console.log('=== 1. Independent Seaspan cycle vs mid-cycle as-of ===');
{
  const independent = periodFromPayday(PAYDAY);
  ok(independent.start === PAYDAY && independent.end === CYCLE_END
      && independent.nextPayday === NEXT_PAYDAY
      && addDays(PAYDAY, 13) === CYCLE_END,
    'hand-stepped Seaspan cycle is Sep 11 through Sep 24');
  ok(AS_OF > PAYDAY && AS_OF < CYCLE_END,
    'as-of Sep 19 sits inside that already-started cycle');
  ok(ONCE_DUE > PAYDAY && ONCE_DUE < AS_OF,
    'once hydro is dated after payday and before the residual start');
}

console.log('\n=== 2. Budget keeps full-cycle This Pay Period ===');
{
  const { plan, debts } = fixture();
  const cycle = F.spendingCycle(plan, AS_OF);
  const independent = periodFromPayday(PAYDAY);
  ok(cycle && cycle.start === independent.start && cycle.end === independent.end
      && cycle.rangeLabel === 'Sep 11–Sep 24',
    'spendingCycle is the full Seaspan payday-to-payday window',
    cycle && `${cycle.start}–${cycle.end} ${cycle.rangeLabel}`);

  const advice = F.recommend(plan, AS_OF, { targetBuffer: 500, debts });
  const active = ((advice.defaultView && advice.defaultView.calendarPeriods) || [])
    .find(p => p && p.id === 'this-pay-period');
  ok(active && active.label === 'This Pay Period'
      && active.start === PAYDAY && active.end === CYCLE_END
      && active.rangeLabel === 'Sep 11–Sep 24'
      && advice.defaultView.title === 'This pay period',
    'Budget This Pay Period stays Sep 11–Sep 24');
  ok(budgetHead(active) === 'This Pay Period · Sep 11–Sep 24',
    'Budget print identity is This Pay Period with the full-cycle dates');

  const planSrc = read('public/plan.js');
  ok(/\$\{escapeHtml\(period\.label\)\}/.test(planSrc)
      && /period\.rangeLabel \? ` · \$\{escapeHtml\(period\.rangeLabel\)\}`/.test(planSrc)
      && /label: 'This Pay Period'/.test(read('public/forecast.js')),
    'Budget page still prints Forecast This Pay Period · rangeLabel');
}

console.log('\n=== 3. Forecast residual is distinctly identified ===');
{
  const { plan, debts } = fixture();
  const traj = F.baselineTrajectory(plan, debts, AS_OF, { periods: periodsFixture() });
  const first = traj.payPeriods && traj.payPeriods[0];
  const independent = periodFromPayday(PAYDAY);
  ok(first && first.payday === PAYDAY && first.nextPayday === NEXT_PAYDAY,
    'Forecast residual still keys the Sep 11 Seaspan payday');
  ok(first.start === AS_OF && first.end === CYCLE_END
      && first.rangeLabel === 'Sep 19–Sep 24',
    'published walk window is the as-of residual Sep 19–24, not the full cycle');
  ok(first.cycleStart === independent.start && first.cycleEnd === independent.end
      && first.cycleRangeLabel === 'Sep 11–Sep 24',
    'full Seaspan cycle dates are published beside the residual, not substituted for it');
  ok(first.windowKind === 'as-of-residual'
      && first.displayIdentity === 'Remaining through next payday',
    'Forecast names the residual Remaining through next payday');
  ok(!/this pay period/i.test(first.displayIdentity || '')
      && first.displayIdentity !== 'This Pay Period'
      && first.label !== 'This Pay Period',
    'Forecast residual does not publish Budget\'s This Pay Period identity');

  const interior = traj.payPeriods.find(p => p.payday === NEXT_PAYDAY);
  ok(interior && interior.windowKind === 'full-cycle'
      && interior.displayIdentity === 'Pay period'
      && interior.start === NEXT_PAYDAY
      && !/this pay period/i.test(interior.displayIdentity),
    'later Forecast blocks stay Pay period, never This Pay Period');
}

console.log('\n=== 4. The two surfaces cannot share This Pay Period for different windows ===');
{
  const { plan, debts } = fixture();
  const advice = F.recommend(plan, AS_OF, { targetBuffer: 500, debts });
  const active = ((advice.defaultView && advice.defaultView.calendarPeriods) || [])
    .find(p => p && p.id === 'this-pay-period');
  const traj = F.baselineTrajectory(plan, debts, AS_OF, { periods: periodsFixture() });
  const first = traj.payPeriods[0];
  const ctx = loadPlanning();
  const road = ctx.planningRoadAheadHtml(traj, 'pay-period', first.payday, AS_OF);
  const html = [road.lead, road.selected, road.timeline, road.viewNote, road.stages, road.periodHeader]
    .filter(Boolean).join('\n');

  ok(active.start !== first.start && active.end === first.end,
    'Budget full cycle and Forecast residual are different date windows');
  ok(active.label === 'This Pay Period' && first.displayIdentity !== active.label
      && first.displayIdentity !== advice.defaultView.title,
    'the two windows do not share the This Pay Period name');

  ok(/Remaining through next payday · from your Forecast plan/.test(html)
      && !/This pay period · from your Forecast plan/.test(html)
      && !/This Pay Period · Sep 19/.test(html),
    'Forecast hero does not caption the residual This pay period');
  ok(/Remaining through next payday · Sep 19–Sep 24/.test(html)
      && /data-road-pay-period-window-kind="as-of-residual"/.test(html)
      && /data-road-pay-period-display-identity="Remaining through next payday"/.test(html),
    'selected Forecast header names remaining through next payday with residual dates');
  ok(/Remainder of the Seaspan cycle Sep 11–Sep 24/.test(html)
      && /Not Budget’s This Pay Period/.test(html)
      && /Sep 19 – Sep 24 remaining/.test(html),
    'copy keeps residual dates and names the full cycle it is remaining of');
  ok(/not Budget’s This Pay Period/.test(road.viewNote)
      && /remaining through next payday/.test(road.viewNote)
      && !/Each block runs from one pay day to the next/.test(road.viewNote),
    'pay-period view note no longer describes the residual as a full payday-to-payday block');
}

console.log('\n=== 5. Financial figures are the clipped walk, not retargeted to agree ===');
{
  const { plan, debts } = fixture();
  const traj = F.baselineTrajectory(plan, debts, AS_OF, { periods: periodsFixture() });
  const first = traj.payPeriods[0];
  const weekly = independentWeekly(plan);
  const walkDays = 6;
  const hb = roundCent(weekly * walkDays / 7);
  ok(first.stage1.householdBudget.walkDays === walkDays
      && near(first.stage1.householdBudget.amount, hb),
    'Household Budget is 6 residual walk days, not the 14-day This Pay Period smear',
    `${first.stage1.householdBudget.walkDays} days / ${first.stage1.householdBudget.amount}`);
  ok(near(first.stage1.bills.amount, ONCE_AMT),
    'Stage 1 bills still include the carried Sep 15 hydro — math was not dropped to match dates');
  const smear14 = roundCent(weekly * 14 / 7);
  ok(!near(first.stage1.householdBudget.amount, smear14, 1),
    'residual Household Budget is not rewritten as a full-cycle 14-day amount');

  const paydayAsOf = F.baselineTrajectory(plan, debts, PAYDAY, { periods: periodsFixture() });
  const full = paydayAsOf.payPeriods[0];
  ok(full && full.start === PAYDAY && full.end === CYCLE_END
      && full.windowKind === 'full-cycle'
      && full.stage1.householdBudget.walkDays === 14,
    'on payday morning the same cycle is a full 14-day Forecast pay period');
  ok(full.stage1.result.amount !== first.stage1.result.amount
      && full.stage1.householdBudget.walkDays !== first.stage1.householdBudget.walkDays,
    'residual figures were not forced to equal the full-cycle This Pay Period figures');
}

console.log('\n=== 6. Pre-residual obligation stays carried; identity stays residual ===');
{
  const { plan, debts } = fixture();
  const traj = F.baselineTrajectory(plan, debts, AS_OF, { periods: periodsFixture() });
  const first = traj.payPeriods[0];
  const line = ((first.stage1.bills && first.stage1.bills.lines) || [])
    .find(row => row && row.id === 'once-hydro');
  ok(line && line.date === ONCE_DUE && near(line.amount, ONCE_AMT),
    'carried once hydro keeps scheduled date Sep 15 inside the Sep 19–24 residual');
  ok(first.windowKind === 'as-of-residual'
      && first.start === AS_OF && first.displayIdentity === 'Remaining through next payday',
    'that carried bill does not relabel the residual as the full This Pay Period');

  const advice = F.recommend(plan, AS_OF, { targetBuffer: 500, debts });
  const active = ((advice.defaultView && advice.defaultView.calendarPeriods) || [])
    .find(p => p && p.id === 'this-pay-period');
  const budgetBill = ((active && active.bills) || [])
    .find(row => row && row.id === 'once-hydro');
  ok(budgetBill && budgetBill.date === ONCE_DUE,
    'Budget This Pay Period still lists the Sep 15 bill on the full Sep 11–24 cycle');

  const ctx = loadPlanning();
  const road = ctx.planningRoadAheadHtml(traj, 'pay-period', first.payday, AS_OF);
  const html = [road.selected, road.breakdown, road.lead].join('\n');
  ok(/An unpaid bill dated earlier in this Seaspan cycle can still appear here/.test(html)
      && /That does not make these dates the full This Pay Period/.test(html),
    'Forecast explains the carried bill instead of hiding it or widening the dates');
}

console.log('\n=== 7. Helper stays inside Forecast; months do not absorb the identity ===');
{
  const src = read('public/forecast.js');
  ok(/function seaspanPayPeriodIdentity\(/.test(src)
      && typeof F.seaspanPayPeriodIdentity !== 'function'
      && typeof F.seaspanPayPeriodsIntersecting !== 'function',
    'pay-period identity helper is not a second exported planner');
  const { plan, debts } = fixture();
  const traj = F.baselineTrajectory(plan, debts, AS_OF, { periods: periodsFixture() });
  const month = traj.months[0];
  ok(month && !month.windowKind && !month.displayIdentity
      && !month.cycleStart && !month.cycleRangeLabel && !month.payday,
    'month rows did not grow pay-period residual identity fields');
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nAll pay-period residual identity checks passed.');
