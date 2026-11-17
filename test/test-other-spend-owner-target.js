'use strict';
/* Other spend $800/month is a Household Budget owner target.
 *
 * Owner-stated 2026-09-18: Forecast assumes $800 of other spend as
 * plan.budget.categories[].plannedMonthly on other-spend. Cadence is
 * calendar-month. Not extraDebtMonthly, not targetBuffer, not a bill or
 * commitment, and not Forecast Other spending confirmation actuals.
 *
 * Independent of Forecast.ownerTargetMonthly (L-002): a plannedMonthly
 * amount is already a calendar-month figure, so the expected monthly
 * target is 800 without conversion. Trajectory smear uses that 800 and
 * the calendar week identity 365.25/12/7, not the producing helper.
 * `node test/test-other-spend-owner-target.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
// Preserve these retired-policy regression assertions against the explicitly
// dated historical policy. The active 450 policy has its own independent suite.
const canonical = require('../data.json');
const live = require('./fixtures/retired-fuel-policy')(canonical);
const retiredOther = live.plan.budget.categories.find(row => row.id === 'other-spend');
const historicalOther = retiredOther.targetHistory?.find(row => row.effectiveThrough === '2026-09-24');
if (!historicalOther) throw new Error('missing dated retired Other policy');
Object.assign(retiredOther, historicalOther);
delete retiredOther.plannedPayday; delete retiredOther.targetEffectiveFrom; delete retiredOther.targetHistory;
if (!(live.meta.asOf <= historicalOther.effectiveThrough)) throw new Error('retired policy cannot stand in for an active-period assertion');
const periods = require('../public/periods.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;

const OTHER_MONTHLY = 800;
const OTHER_ID = 'other-spend';
const OTHER_LABEL = 'Other spend';
const CALENDAR_MONTH_DAYS = 365.25 / 12;
const WEEKS_PER_MONTH = CALENDAR_MONTH_DAYS / 7;
const START = '2026-06-15';
const JUL = '2026-07';
const SEP = '2026-09';
const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

function addDays(iso, n) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return [
    dt.getUTCFullYear(),
    String(dt.getUTCMonth() + 1).padStart(2, '0'),
    String(dt.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function independentOwnerTargetMonthly(cat) {
  if (!cat) return null;
  if (cat.plannedWeekly != null) {
    return roundCent(Number(cat.plannedWeekly) * CALENDAR_MONTH_DAYS / 7);
  }
  if (cat.plannedPayday != null) {
    if (cat.paydayCadence === 'first-seaspan-of-month'
        || cat.paydayCadence === 'every-other-seaspan') {
      return roundCent(Number(cat.plannedPayday) || 0);
    }
    return roundCent(Number(cat.plannedPayday) * CALENDAR_MONTH_DAYS / 14);
  }
  if (cat.plannedMonthly != null) return roundCent(Number(cat.plannedMonthly) || 0);
  return null;
}

function cats(plan) {
  return (plan && plan.budget && plan.budget.categories) || [];
}
function byId(plan, id) {
  return cats(plan).find(c => c && c.id === id) || null;
}
function lineByLabel(lines, label) {
  return (lines || []).find(row => row && row.label === label) || null;
}

function periodsFixture() {
  return {
    periods: {
      ytd: {
        label: 'YTD fixture',
        months: 1,
        spending: [{ label: 'Groceries', total: 1 }],
      },
    },
  };
}

function syntheticPlan() {
  return {
    windowDays: 91,
    startingCash: { amount: 8000 },
    defaults: { targetBuffer: 200, extraDebtMonthly: 0, scenario: 'expected' },
    opening: { asOf: START },
    budget: {
      basis: 'ytd',
      categories: [
        {
          id: OTHER_ID,
          label: OTHER_LABEL,
          class: 'essential',
          historyCategories: [],
          plannedMonthly: OTHER_MONTHLY,
          ownerLine: OTHER_LABEL,
          targetSource: 'owner-stated-2026-09-18',
        },
        {
          id: 'travel',
          label: 'Travel',
          class: 'discretionary',
          historyCategories: ['Travel'],
        },
      ],
    },
    income: [{
      id: 'payroll', label: 'Payroll — Seaspan',
      frequency: 'biweekly', anchor: '2026-06-12',
      amount: 2000, confidence: 'estimated',
    }],
    obligations: [],
    bills: [],
    commitments: [],
  };
}

const debts = [{
  id: 'card', label: 'Synthetic card',
  balance: 600, pending: 0, rate: 19.99, rateConvention: 'card',
  structure: 'Revolving — synthetic', secured: false, limit: 1500,
}];

const INDEPENDENT_WEEKLY = roundCent(OTHER_MONTHLY / WEEKS_PER_MONTH);

console.log('=== 1. Live JSON home is other-spend.plannedMonthly 800 ===');
{
  const row = byId(live.plan, OTHER_ID);
  const uncat = byId(live.plan, 'uncategorised');
  ok(!!row, 'other-spend category exists on the live plan');
  ok(row && row.plannedMonthly === OTHER_MONTHLY,
    'exact JSON home is plan.budget.categories[id=other-spend].plannedMonthly = 800',
    row ? String(row.plannedMonthly) : 'missing');
  ok(row && row.plannedPayday == null && row.plannedWeekly == null
      && row.paydayCadence == null,
    'other-spend has no payday or weekly cadence',
    row ? `${row.plannedPayday}/${row.plannedWeekly}/${row.paydayCadence}` : 'missing');
  ok(row && row.ownerLine === OTHER_LABEL
      && row.targetSource === 'owner-stated-2026-09-18'
      && row.label === OTHER_LABEL,
    'ownerLine / targetSource / label are owner-stated Other spend this turn');
  ok(row && Array.isArray(row.historyCategories) && row.historyCategories.length === 0,
    'other-spend has no Lunch Money from-mapping; it is a planning home, not a classification bucket');
  ok(uncat && uncat.plannedMonthly == null && uncat.id === 'uncategorised',
    'uncategorised remains the unmatched-merchant remainder, not the $800 home');
  ok(independentOwnerTargetMonthly(row) === OTHER_MONTHLY,
    'independent: plannedMonthly 800 is already a calendar-month figure, so monthly target is 800',
    String(independentOwnerTargetMonthly(row)));
}

console.log('\n=== 2. Named grocery / fuel / eating-out / guilt-free amounts are unchanged ===');
{
  const groceries = byId(live.plan, 'groceries');
  const fuel = byId(live.plan, 'fuel');
  const restaurants = byId(live.plan, 'restaurants');
  const dale = byId(live.plan, 'dale-guilt-free');
  const amanda = byId(live.plan, 'amanda-guilt-free');
  ok(groceries && groceries.plannedPayday === 900 && groceries.plannedMonthly == null
      && groceries.plannedWeekly == null
      && groceries.targetSource === 'owner-stated-2026-09-22',
    'groceries is plannedPayday 900 with no stored monthly target');
  ok(fuel && fuel.plannedPayday === 325 && fuel.plannedMonthly == null,
    'fuel stays plannedPayday 325');
  ok(restaurants && restaurants.plannedPayday === 200 && restaurants.plannedMonthly == null,
    'eating out stays plannedPayday 200');
  ok(dale && dale.plannedPayday === 150 && dale.plannedMonthly == null,
    'Dale guilt-free stays plannedPayday 150');
  ok(amanda && amanda.plannedPayday === 150 && amanda.plannedMonthly == null,
    'Amanda guilt-free stays plannedPayday 150');
}

console.log('\n=== 3. Not extraDebtMonthly, targetBuffer, a bill, or a commitment ===');
{
  const extra = live.plan.defaults && live.plan.defaults.extraDebtMonthly;
  const buffer = live.plan.defaults && live.plan.defaults.targetBuffer;
  ok(extra === 0 && extra !== OTHER_MONTHLY,
    'plan.defaults.extraDebtMonthly is not the $800 other-spend home',
    String(extra));
  ok(buffer !== OTHER_MONTHLY,
    'plan.defaults.targetBuffer is not the $800 other-spend home',
    String(buffer));
  ok(!(live.plan.bills || []).some(b => b && (b.id === OTHER_ID || b.budgetCategory === OTHER_ID
      || /other spend/i.test(b.label || ''))),
    'no bill was invented for other spend');
  ok(!(live.plan.commitments || []).some(c => c && (c.id === OTHER_ID
      || c.budgetCategory === OTHER_ID || /other spend/i.test(c.label || ''))),
    'no commitment was invented for other spend');
  ok(!(live.plan.commitments || []).some(c => c && (c.id === 'seattle-nov'
      || c.id === 'seattle-dec' || c.id === 'christmas-2026') && c.amount === OTHER_MONTHLY),
    'dating-tip commitments were not used as the $800 home');
}

console.log('\n=== 4. ownerTargets lock includes Other spend $800/month ===');
{
  const note = live.plan.budget.ownerTargets.note;
  ok(/Other spend \$800\/month/.test(note) && /plannedMonthly 800/.test(note)
      && /other-spend/.test(note) && /2026-09-18/.test(note),
    'ownerTargets.note records the Other spend $800/month lock');
  ok(/\$1,825\.00/.test(note) && /\$1,725\.00/.test(note)
      && !/\$1,375\.00/.test(note) && !/\$1,275\.00/.test(note),
    'payday-cycle totals are $1,825.00 / $1,725.00; $800/month is not converted into a payday hold');
}

console.log('\n=== 5. Forecast Other spending confirmation row is not the planning home ===');
{
  const src = read('public/forecast.js');
  ok(/const OTHER_SPENDING_ID = 'other-spending'/.test(src),
    'Forecast confirmation actuals still use OTHER_SPENDING_ID other-spending');
  ok(OTHER_ID !== 'other-spending',
    'the planning category id is other-spend, distinct from other-spending');
  const calendarIds = src.slice(
    src.indexOf('const CALENDAR_PERIOD_BUDGET_IDS = ['),
    src.indexOf('function householdBudgetSupportingSpendEligible('));
  ok(!/'other-spend'/.test(calendarIds),
    'CALENDAR_PERIOD_BUDGET_IDS does not hold other-spend on the calendar waterfall');
  ok(/const OTHER_SPENDING_ID = 'other-spending'/.test(src)
      && calendarIds.indexOf('other-spending') < 0,
    'confirmation other-spending is not a calendar planned id');
}

console.log('\n=== 6. budgetBreakdown owner-target monthly is independently 800 ===');
{
  const bd = F.budgetBreakdown(live.plan, periods, { paypalPerMonth: live.paypal.perMonth });
  const row = (bd.categories || []).find(c => c && c.id === OTHER_ID);
  ok(row && row.source === 'owner-target',
    'budgetBreakdown labels other-spend as owner-target',
    row ? String(row.source) : 'missing');
  ok(row && near(row.target, OTHER_MONTHLY) && near(row.planned, OTHER_MONTHLY),
    'budgetBreakdown target and planned remainder are independently $800',
    row ? `${row.target}/${row.planned}` : 'missing');
  ok(row && near(row.target, independentOwnerTargetMonthly(byId(live.plan, OTHER_ID))),
    'engine target agrees with the independent plannedMonthly identity');
  const contributing = (bd.categories || [])
    .filter(c => c && c.class !== 'reserve' && c.source !== 'historical-actual')
    .reduce((s, c) => s + (Number(c.planned) || 0), 0);
  ok(contributing >= OTHER_MONTHLY - 0.005,
    'Household Budget planned remainder includes at least the $800 other-spend',
    String(contributing));
}

console.log('\n=== 7. Synthetic trajectory Household Budget path is 800/month ===');
{
  const plan = syntheticPlan();
  const bd = F.budgetBreakdown(plan, periodsFixture(), { asOf: START });
  const row = (bd.categories || []).find(c => c && c.id === OTHER_ID);
  const travel = (bd.categories || []).find(c => c && c.id === 'travel');
  ok(row && near(row.target, OTHER_MONTHLY) && row.source === 'owner-target',
    'synthetic budgetBreakdown other-spend target is 800');
  ok(travel && travel.source === 'historical-actual',
    'synthetic Travel stays historical-actual and is not the $800 home');

  const traj = F.baselineTrajectory(plan, debts, START, { periods: periodsFixture() });
  ok(traj && traj.status === 'ready', 'synthetic trajectory is ready');
  ok(traj.weeklyVariable && near(traj.weeklyVariable.amount, INDEPENDENT_WEEKLY),
    'trajectory weeklyVariable equals independently 800 / calendar weeks',
    traj.weeklyVariable ? `${traj.weeklyVariable.amount} vs ${INDEPENDENT_WEEKLY}` : 'missing');
  ok(traj.weeklyVariable && traj.weeklyVariable.historicalActuals === 'excluded',
    'planned weeklyVariable still excludes historical actuals');

  const july = (traj.months || []).find(m => m.month === JUL);
  ok(july && july.stage1 && july.stage1.householdBudget
      && july.stage1.status !== 'unavailable',
    'July Stage 1 householdBudget is published');
  const walkDays = july.stage1.householdBudget.walkDays;
  const priorDays = (Date.parse(july.start) - Date.parse(START)) / 86400000;
  const expectedSmear = roundCent(roundCent(INDEPENDENT_WEEKLY * (priorDays + walkDays) / 7)
    - roundCent(INDEPENDENT_WEEKLY * priorDays / 7));
  ok(near(july.stage1.householdBudget.amount, expectedSmear),
    'Stage 1 householdBudget amount is the independent 800-month smear',
    `${july.stage1.householdBudget.amount} vs ${expectedSmear}`);
  const otherLine = lineByLabel(july.stage1.householdBudget.lines, OTHER_LABEL);
  ok(otherLine && near(otherLine.amount, expectedSmear) && otherLine.status === 'calculated',
    'Stage 1 householdBudget lines include Other spend at the independent smear',
    otherLine ? `${otherLine.amount}` : 'missing');
  ok(!(july.stage1.householdBudget.lines || []).some(l => /travel/i.test(l.label || '')),
    'historical-actual Travel is not published as a Household Budget line');
}

console.log('\n=== 8. Live trajectory Household Budget path includes the $800 monthly ===');
{
  const asOf = live.meta.asOf;
  const trajOpts = { periods, extraFacilities: live.revolvingExtra };
  const traj = F.baselineTrajectory(live.plan, live.debts, asOf, trajOpts);
  ok(traj && traj.status === 'ready', 'live trajectory is ready');

  const liveBd = F.budgetBreakdown(live.plan, periods, {
    paypalPerMonth: live.paypal.perMonth,
    asOf,
    extraFacilities: live.revolvingExtra,
  });
  const otherBd = (liveBd.categories || []).find(c => c && c.id === OTHER_ID);
  ok(otherBd && near(otherBd.planned, OTHER_MONTHLY),
    'live budgetBreakdown planned remainder for other-spend is 800');

  const without = JSON.parse(JSON.stringify(live.plan));
  const withoutRow = byId(without, OTHER_ID);
  withoutRow.plannedMonthly = null;
  delete withoutRow.ownerLine;
  delete withoutRow.targetSource;
  const bdWithout = F.budgetBreakdown(without, periods, {
    paypalPerMonth: live.paypal.perMonth,
    asOf,
    extraFacilities: live.revolvingExtra,
  });
  const rowWithout = (bdWithout.categories || []).find(c => c && c.id === OTHER_ID);
  ok(rowWithout && rowWithout.source === 'historical-actual' && near(rowWithout.planned, 0),
    'removing plannedMonthly 800 drops other-spend out of the planned remainder (empty from → historical 0)');
  const trajWithout = F.baselineTrajectory(without, live.debts, asOf, trajOpts);
  ok(trajWithout && trajWithout.status === 'ready', 'clone without the $800 still forms a trajectory');
  ok(near(traj.weeklyVariable.amount - trajWithout.weeklyVariable.amount, INDEPENDENT_WEEKLY),
    'live weeklyVariable rises by independently 800 / calendar weeks when the owner target is present',
    `${traj.weeklyVariable.amount} − ${trajWithout.weeklyVariable.amount} vs ${INDEPENDENT_WEEKLY}`);

  const sep = (traj.months || []).find(m => m.month === SEP);
  const sepWithout = (trajWithout.months || []).find(m => m.month === SEP);
  ok(sep && sep.stage1 && sep.stage1.householdBudget
      && sep.stage1.status !== 'unavailable',
    'live September Stage 1 householdBudget is published');
  const walkDays = sep.stage1.householdBudget.walkDays;
  const priorDays = (Date.parse(sep.start) - Date.parse(asOf)) / 86400000;
  const cats = (liveBd.categories || []).filter(c =>
    c && c.class !== 'reserve' && c.source !== 'historical-actual'
    && isFinite(Number(c.planned)) && Number(c.planned) > 0);
  const weights = cats.map(c => Math.round(Number(c.planned) * 100));
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const fortnightCents = Math.round(traj.weeklyVariable.amount * 200);
  const through = days => {
    const seats = weights.map(() => 0);
    if (!(days > 0) || !(totalWeight > 0)) return seats;
    let remainder = 7;
    for (let d = 0; d < days; d++) {
      remainder += fortnightCents;
      const pennies = Math.floor(remainder / 14);
      remainder %= 14;
      if (pennies <= 0) continue;
      let given = 0;
      const parts = weights.map((w, i) => {
        const num = pennies * w;
        const floor = Math.floor(num / totalWeight);
        seats[i] += floor;
        given += floor;
        return { i, rem: num % totalWeight };
      });
      parts.sort((a, b) => b.rem - a.rem || a.i - b.i);
      for (let k = 0; k < pennies - given; k++) seats[parts[k].i] += 1;
    }
    return seats;
  };
  const otherIndex = cats.findIndex(c => c.id === OTHER_ID);
  const expectedOtherLine = (through(priorDays + walkDays)[otherIndex]
    - through(priorDays)[otherIndex]) / 100;
  const otherLine = lineByLabel(sep.stage1.householdBudget.lines, OTHER_LABEL);
  ok(otherLine && near(otherLine.amount, expectedOtherLine) && otherLine.status === 'calculated',
    'live September householdBudget lines include Other spend from independently smeared $800/month',
    otherLine ? `${otherLine.amount} vs ${expectedOtherLine}` : 'missing');
  const withoutLines = sepWithout && sepWithout.stage1 && sepWithout.stage1.householdBudget
    && sepWithout.stage1.householdBudget.lines;
  ok(!lineByLabel(withoutLines, OTHER_LABEL),
    'without the owner target, September does not publish an Other spend Household Budget line');
}

function bootPlanPage(payload, periodsOverride) {
  const els = new Map();
  const makeEl = id => {
    const el = {
      id, textContent: '', value: '', placeholder: '', checked: false, hidden: false,
      className: '', style: {}, children: [], listeners: {}, attributes: {},
      addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); },
      setAttribute(k, v) { this.attributes[k] = v; },
      removeAttribute(k) { delete this.attributes[k]; },
      appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
      append(...children) { for (const child of children) this.appendChild(child); },
      remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; } },
      insertAdjacentHTML(_, h) { this.innerHTML = String(h); },
      querySelectorAll: () => [],
    };
    let html = '';
    Object.defineProperty(el, 'innerHTML',
      { get: () => html, set(v) { html = String(v); el.children = []; } });
    return el;
  };
  const get = id => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const sandbox = {
    document: {
      getElementById: get,
      createElement: () => makeEl('created'),
      createElementNS: () => makeEl('svg'),
      querySelector: () => null, querySelectorAll: () => [],
      documentElement: makeEl('html'), body: { scrollHeight: 0 },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {}, matchMedia: () => ({ addEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame() {}, innerWidth: 1200, innerHeight: 800, scrollY: 0, console,
    fetch: url => Promise.resolve({
      status: 200, ok: true,
      json: () => (String(url).includes('periods') ? (periodsOverride || periods)
        : String(url).includes('balance-history') ? null : payload),
    }),
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  Object.assign(sandbox, { AbortController, setTimeout, clearTimeout });
  vm.createContext(sandbox);
  for (const file of ['public/app.js', 'public/forecast.js', 'public/budget-surface.js', 'public/plan.js']) {
    vm.runInContext(read(file), sandbox, { filename: file });
  }
  return { get };
}
const settle = () => new Promise(r => setTimeout(r, 0));
const catRow = (html, label) => {
  const rows = String(html || '').split(/<div class="cat-row">/).slice(1);
  const row = rows.find(r => r.includes(label));
  return row ? `<div class="cat-row">${row}` : '';
};

console.log('\n=== 9. Budget breakdown shows the target-only Other spend row ===');
(async () => {
  const planSrc = read('public/plan.js');
  const filterIdx = planSrc.indexOf('const cats = budget.categories.filter');
  const filterSrc = planSrc.slice(filterIdx, filterIdx + 220);
  ok(/c\.target\s*!=\s*null/.test(filterSrc) && /c\.planned\s*>\s*0/.test(filterSrc),
    'Budget category table includes owner-target and planned-only rows, not only historical/dated actuals');

  const SYNTHETIC_MONTHLY = 250;
  const SYNTHETIC_LABEL = 'Synthetic other';
  const synthPlan = syntheticPlan();
  synthPlan.budget.categories[0].label = SYNTHETIC_LABEL;
  synthPlan.budget.categories[0].ownerLine = SYNTHETIC_LABEL;
  synthPlan.budget.categories[0].plannedMonthly = SYNTHETIC_MONTHLY;
  const synthPayload = {
    meta: { asOf: START },
    debts: [], revolvingExtra: [], paypal: null, helocHistory: [],
    plan: Object.assign({
      obligations: [], bills: [], commitments: [], actions: [],
      defaults: { scenario: 'expected', extraDebtMonthly: 0, targetBuffer: 200 },
    }, synthPlan),
  };
  const synthPage = bootPlanPage(synthPayload, periodsFixture());
  await settle();
  ok(/data-budget-surface=/.test(synthPage.get('operating-surface-body').innerHTML),
    'the active Budget renderer completes during boot');
  const synthCats = synthPage.get('budget-cats').innerHTML;
  const synthRow = catRow(synthCats, SYNTHETIC_LABEL);
  const synthBd = F.budgetBreakdown(synthPlan, periodsFixture(), { asOf: START });
  const synthEngine = (synthBd.categories || []).find(c => c && c.id === OTHER_ID);
  ok(synthEngine && near(synthEngine.historical, 0) && near(synthEngine.dated, 0)
      && near(synthEngine.target, SYNTHETIC_MONTHLY) && near(synthEngine.planned, SYNTHETIC_MONTHLY),
    'synthetic target-only row has no historical/dated actuals and planned 250');
  ok(synthRow.includes(SYNTHETIC_LABEL) && /owner budget/.test(synthRow),
    'synthetic Budget breakdown still prints the target-only row');
  ok(synthRow.includes(`budgeted $${SYNTHETIC_MONTHLY}`)
      && /cat-amt[\s\S]*\$250/.test(synthRow),
    'synthetic row is reconcilable at independently budgeted $250',
    synthRow.slice(0, 240));
  ok(synthPage.get('cap-basis').innerHTML.toLowerCase().includes(SYNTHETIC_LABEL.toLowerCase()),
    'explanatory target list includes the synthetic owner-target category');

  const livePage = bootPlanPage(live, periods);
  await settle();
  const liveCats = livePage.get('budget-cats').innerHTML;
  const liveRow = catRow(liveCats, OTHER_LABEL);
  const liveBd = F.budgetBreakdown(live.plan, periods, { paypalPerMonth: live.paypal.perMonth });
  const liveEngine = (liveBd.categories || []).find(c => c && c.id === OTHER_ID);
  ok(liveEngine && near(liveEngine.target, OTHER_MONTHLY) && near(liveEngine.planned, OTHER_MONTHLY)
      && near(liveEngine.historical, 0) && near(liveEngine.dated, 0),
    'live Other spend remains target-only $800 with no historical/dated actuals');
  ok(liveRow.includes(OTHER_LABEL) && /owner budget/.test(liveRow),
    'live Budget breakdown prints Other spend');
  ok(liveRow.includes(`budgeted $${OTHER_MONTHLY}`)
      && /cat-amt[\s\S]*\$800/.test(liveRow),
    'live Other spend row is reconcilable at independently budgeted $800');
  ok(/essential rows, which are \$[\d,]+\/month/.test(livePage.get('budget-cats-note').textContent),
    'Budget note still publishes the essential total the Other spend row can reconcile against');
  ok(livePage.get('cap-basis').innerHTML.toLowerCase().includes('other spend'),
    'explanatory target list includes Other spend');

  console.log('\n=== 10. Derived essentials reporting is dated no earlier than the owner target ===');
  {
    const csv = read('docs/positions.csv').split(/\r?\n/).filter(Boolean).map(line => {
      const out = []; let cur = '', q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; continue; }
        if (ch === ',' && !q) { out.push(cur); cur = ''; continue; }
        cur += ch;
      }
      out.push(cur); return out;
    });
    const csvRow = label => csv.find(c => c[2] === label) || [];
    const ownerDates = cats(canonical.plan)
      .map(c => (/owner-stated-(\d{4}-\d{2}-\d{2})/.exec(String(c.targetSource || '')) || [])[1])
      .filter(Boolean)
      .sort();
    const latestOwner = ownerDates[ownerDates.length - 1] || '';
    ok(latestOwner >= '2026-10-04',
      'independent latest owner-stated date includes the Other instruction and later approved targets',
      latestOwner);
    ok(String(csvRow('Essential spending estimate')[19] || '') >= latestOwner,
      'positions.csv essential-spending as_of is not earlier than the owner target',
      String(csvRow('Essential spending estimate')[19] || ''));
    ok(String(csvRow('Weeks of essentials covered')[19] || '') >= latestOwner,
      'positions.csv weeks-of-essentials as_of is not earlier than the owner target',
      String(csvRow('Weeks of essentials covered')[19] || ''));
    ok(String(csvRow('Essential spending estimate')[20] || '').includes(`owner budget target ${latestOwner}`)
        && String(csvRow('Weeks of essentials covered')[20] || '').includes(`owner budget target ${latestOwner}`),
      'derived essentials notes name the latest owner-target date');
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
