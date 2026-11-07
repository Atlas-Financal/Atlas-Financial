'use strict';
// A card whose current pending is unknown has an unknown consumer exposure:
// posted plus an unknown amount. Forecast publishes the consumer-debt total
// as unknown on every mark (day zero included) and in every trajectory month,
// and every reader says unavailable, never $0 and never posted + the retained
// dated pending. The debt walk itself is unchanged.
//
// Independent invented ledger: card posted 600, retained pending 40, limit
// 1500; HELOC 5000 secured. Expected values are written by hand.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.ATLAS_TEST_APP_ROOT || path.join(__dirname, '..');
const F = require(path.join(root, 'public/forecast'));

let checks = 0;
function eq(a, b, why) { assert.deepEqual(a, b, why); checks++; }
function yes(v, why) { assert.ok(v, why); checks++; }

const START = '2026-06-15';
function fixture(unknown, helocBalance = 5000) {
  const plan = {
    windowDays: 91,
    startingCash: { amount: 2500 },
    defaults: { targetBuffer: 200, extraDebtMonthly: 0, scenario: 'expected' },
    opening: { asOf: START },
    budget: { basis: 'ytd', categories: [{ id: 'groceries', label: 'Groceries', class: 'essential',
      from: ['Groceries'], plannedWeekly: 140 }] },
    income: [{ id: 'payroll', label: 'Synthetic payroll', frequency: 'biweekly', anchor: '2026-06-12',
      amount: 2000, confidence: 'estimated' }],
    obligations: [{ id: 'card-min', debtId: 'card', effect: 'payment', label: 'Card minimum',
      frequency: 'monthly', day: 20, amount: 80, confidence: 'confirmed' }],
    bills: [], commitments: [],
  };
  const debts = [
    { id: 'card', label: 'Synthetic card', balance: 600, pending: 40, rate: 19.99, rateConvention: 'card',
      structure: 'Revolving — synthetic', secured: false, limit: 1500,
      ...(unknown ? { pendingUnknown: true } : {}) },
    { id: 'heloc', label: 'Synthetic HELOC', balance: helocBalance, pending: 0, rate: 7, structure: 'HELOC',
      secured: true, limit: 10000 },
  ];
  return { plan, debts };
}
const periods = { periods: { ytd: { label: 'YTD fixture', months: 1,
  spending: [{ label: 'Groceries', total: 50000 }] } } };

const known = fixture(false);
const unknown = fixture(true);
const knownProj = F.projectDebts(known.plan, known.debts, START);
const unknownProj = F.projectDebts(unknown.plan, unknown.debts, START);

// ── Projection: consumer debt is unknown on every mark, day zero included. ──
eq(knownProj.marks[0].consumer, 640, 'known: day-zero consumer debt is posted 600 + pending 40');
eq(unknownProj.marks.length > 1, true, 'the walk publishes more than the day-zero mark');
eq(unknownProj.marks.every(m => m.consumer === null), true, 'unknown: consumer debt is null on every mark');

// ── The walk is unchanged by the unknown: schedule, payments, interest,
// secured and HELOC are identical to the known walk, mark by mark. ──
const walk = proj => proj.marks.map(m => ({ day: m.day, date: m.date, secured: m.secured, heloc: m.heloc,
  interestToDate: m.interestToDate,
  debts: m.debts.map(d => ({ id: d.id, balance: d.balance, paid: d.paid, interest: d.interest })) }));
eq(walk(unknownProj), walk(knownProj), 'unknown: every walk field except consumer debt is unchanged');

// ── Trajectory: each month's consumer debt is null, never 0; secured is
// unchanged; no consumer-debt direction is claimed. ──
const knownTraj = F.baselineTrajectory(known.plan, known.debts, START, { periods });
const unknownTraj = F.baselineTrajectory(unknown.plan, unknown.debts, START, { periods });
eq(knownTraj.status, 'ready', 'known trajectory is ready');
yes(knownTraj.months.some(m => m.debt && m.debt.consumer > 0), 'known trajectory publishes consumer debt');
eq(unknownTraj.months.every(m => m.debt && m.debt.status === 'calculated' && m.debt.consumer === null), true,
  'unknown trajectory: every month publishes consumer debt as null');
eq(unknownTraj.months.map(m => m.debt.secured), knownTraj.months.map(m => m.debt.secured),
  'unknown trajectory: secured debt is unchanged');
eq(unknownTraj.debtDirection.status, 'unavailable', 'unknown trajectory: no debt direction from an unknown total');

// ── Real page readers. ──
function page(file, data) {
  const els = {};
  const el = id => new Proxy({ id, innerHTML: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } },
  { get(t, k) { return k in t ? t[k] : () => null; } });
  const ctx = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
    getComputedStyle() { return { getPropertyValue() { return ''; } }; },
    requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    document: { addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
      getElementById(id) { return els[id] || (els[id] = el(id)); },
      createElement() { return el('x'); }, createElementNS() { return el('x'); },
      createTextNode() { return el('t'); }, documentElement: { dataset: {}, style: {} }, body: el('body') },
    window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/' } });
  vm.runInContext(fs.readFileSync(path.join(root, 'public/app.js'), 'utf8'), ctx);
  vm.runInContext('App.boot = () => {};', ctx);
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx);
  return { ctx, els };
}
const served = fx => ({ meta: { asOf: START }, plan: fx.plan, debts: fx.debts, revolvingExtra: [] });
for (const [label, fx, expectConsumer] of [['known', known, '$640'], ['unknown', unknown, 'unavailable']]) {
  const { ctx, els } = page('public/plan.js', served(fx));
  ctx.served = served(fx);
  vm.runInContext('Object.assign(state, served.plan.defaults, { debts: served.debts });', ctx);
  // The real Budget renderer; later DOM-only steps may stop on the stub after
  // the snapshot tiles and the scoreboard are written.
  try { vm.runInContext('renderPlan(served, null, null)', ctx); } catch (e) { /* DOM stub limit */ }
  const tiles = (els['snapshot-tiles'] || {}).innerHTML || '';
  eq((tiles.match(/Consumer debt<\/div><div class="val">([^<]*)/) || [])[1], expectConsumer,
    label + ': Budget snapshot tile prints ' + expectConsumer);
  const score = (els['score-table'] || {}).innerHTML || '';
  const consumerRow = (score.match(/<td>Consumer card debt<\/td>([\s\S]*?)<\/tr>/) || [])[1] || '';
  const cells = [...consumerRow.matchAll(/<td class="num[^"]*">([^<]*)<\/td>/g)].map(m => m[1]);
  eq(cells.length, 4, label + ': scoreboard shows Today and Days 30/60/90');
  if (fx === unknown) {
    eq(cells, ['unavailable', 'unavailable', 'unavailable', 'unavailable'],
      'unknown: scoreboard consumer debt is unavailable, never $0');
    const cards = (els['score-cards'] || {}).innerHTML || '';
    yes(!/Consumer card debt<\/span><span>\$/.test(cards) && /Consumer card debt<\/span><span>unavailable/.test(cards),
      'unknown: stacked score cards say unavailable');
  } else {
    eq(cells[0], '$640', 'known: scoreboard Today consumer debt is $640');
  }
  ctx.today = (fx === unknown ? unknownProj : knownProj).marks[0];
  const hero = vm.runInContext('currentOperatingConsumerDebtHeroTile({}, null, today)', ctx);
  eq(hero.val, expectConsumer, label + ': consumer debt hero tile');
  if (fx === unknown) {
    const phase = vm.runInContext("PHASE_BODY['31-60']({ consumerMove: null, consumerDirection: null, consumer60: null, headroom60: 0 })", ctx);
    yes(/unavailable/.test(phase) && !/moves \$0/.test(phase), 'unknown: phase copy says unavailable, never "moves $0"');
  }
}
// Planning's trajectory cell for a month whose consumer debt is unknown.
{
  const { ctx } = page('public/planning.js', served(unknown));
  ctx.month = unknownTraj.months[0].debt;
  const html = vm.runInContext('planningTrajectoryDebtHtml(month)', ctx);
  yes(/data-trajectory-debt="consumer"><b>Unavailable<\/b>/.test(html), 'unknown: Planning trajectory consumer cell says Unavailable');
  yes(!/data-trajectory-debt="consumer"><b>\$0\.00/.test(html), 'unknown: Planning never prints $0.00 consumer debt');
}

// ── 61–90 phase: no direction is claimed from an unknown consumer total. ──
{
  const title = fx => {
    const plan = JSON.parse(JSON.stringify(fx.plan));
    plan.income[0].confidence = 'confirmed';
    const rec = F.recommend(plan, START, { scenario: 'expected', targetBuffer: 200, extraDebtMonthly: 0,
      incomeOverrides: {}, disabled: [], debts: fx.debts, periods });
    const proj = F.projectDebts(plan, fx.debts, START, { weeklyVariable: rec.weekly });
    return F.planPhases(plan, rec, proj, { sim: rec.sim }).phases[2].titleId;
  };
  eq(title(known), 'surplusToPrincipal', 'known: consumer 640 falls by day 90 under the minimum payments');
  eq(title(unknown), 'consumerUnknown', 'unknown: 61–90 claims neither growth nor decline');
}

// ── Pressure: a known facility fact survives an unknown consumer total. HELOC
// 9,990 of a 10,000 limit crosses within the horizon on both; the unknown
// card's total-based signals are withheld, and the withholding is stated. ──
{
  const near = unknownCard => fixture(unknownCard, 9990);
  const pressure = fx => F.baselineTrajectory(fx.plan, fx.debts, START, { periods }).pressure;
  const crossing = p => p.signals.filter(x => x.kind === 'debt-limit-crossing' && x.debtId === 'heloc')
    .map(x => x.date);
  const knownP = pressure(near(false));
  const unknownP = pressure(near(true));
  yes(crossing(knownP).length === 1, 'known: HELOC limit crossing is published');
  eq(crossing(unknownP), crossing(knownP), 'unknown card: the same HELOC limit crossing is still published');
  eq(knownP.withheld, undefined, 'known: nothing is withheld');
  yes(unknownP.withheld && unknownP.withheld.months > 0 && /pending is unknown/.test(unknownP.withheld.reason),
    'unknown card: pressure states that debt-total signals are withheld');
  const { ctx } = page('public/planning.js', served(unknown));
  ctx.traj = { pressure: unknownP };
  const html = vm.runInContext('planningTrajectoryPressureHtml(traj)', ctx).list;
  yes(/data-trajectory-pressure-withheld=/.test(html) && /pending is unknown/.test(html),
    'unknown card: Planning shows the withheld note beside the signals');
}

console.log('PASS a card with unknown pending makes consumer debt unknown in every Forecast publication, and readers say unavailable: '
  + checks + ' independent checks');
