'use strict';
// One funding schedule, no second one (authority defect from the contradiction
// sweep). The Today sheet's "Nest Money funding plan" used to re-run Forecast's
// older cash-walk chain on the page, so on the invented Budget surface it
// printed School trip $400 on Aug 28 while Forecast's published pay-period
// funding (the Savings goals proposals and From today) said $195 + $205. The
// page now only reprints the schedule Forecast publishes on the current period,
// cut from the same selected-Budget walk as every period's plannedCostFunding.
// This renders the real page and compares both places. Invented data only;
// every expected figure below is read from Forecast's published periods and
// the hand-written fixture costs (School trip 400 due Sep 12, Winter tires 900
// due Oct 15), never from the sheet.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const fx = require('./fixtures/budget-surface-data');

const ROOT = path.join(__dirname, '..');
let failures = 0;
function ok(cond, msg, detail) {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${msg}${!cond && detail ? `  — ${detail}` : ''}`);
  if (!cond) failures++;
}
const money = n => '$' + n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function stubEl() {
  return { innerHTML: '', textContent: '', hidden: false, value: '',
    style: { setProperty() {}, getPropertyValue() { return ''; } }, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, hasAttribute() { return false; },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild() {}, insertAdjacentHTML() {}, closest() { return null; }, children: [] };
}

// Load the Budget page scripts in index.html order.
function page() {
  const els = new Map();
  const context = vm.createContext({ Forecast: F, console, addEventListener() {}, setTimeout, clearTimeout,
    document: { addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
      getElementById(id) { if (!els.has(id)) els.set(id, stubEl()); return els.get(id); },
      documentElement: { dataset: {}, style: {} }, createElement: stubEl, createElementNS: stubEl, body: stubEl() },
    window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  // In a browser window is the global object; page scripts register on it.
  context.window = Object.assign(context, { matchMedia() { return { matches: false, addEventListener() {} }; } });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8'), context);
  vm.runInContext('App.boot = () => {}; App.once = () => {}; App.register = () => {};', context);
  for (const f of ['forecast-chequing.js', 'balance-history.js', 'bill-detail.js', 'savings-inventory.js',
    'budget-surface.js', 'plan.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), context);
  }
  // Charts need a real SVG DOM; they are not part of this surface.
  vm.runInContext('forecastChart = () => {}; renderCalendar = () => {};', context);
  vm.runInContext(`globalThis.__retainedCalls = 0;
    const __retained = operatingSurfaceHtml;
    operatingSurfaceHtml = function (ctx) { globalThis.__retainedCalls++; return __retained(ctx); };
    const __active = budgetSurfaceHtml;
    budgetSurfaceHtml = function (ctx) { globalThis.__ctx = ctx; return __active(ctx); };`, context);
  return {
    context,
    render(served) {
      context.served = served;
      // App.boot sets App.data to the served packet before renderPlan runs.
      vm.runInContext("Object.defineProperty(App, 'data', { get: () => served, configurable: true });", context);
      vm.runInContext('Object.assign(state, served.plan.defaults, { debts: served.debts }); renderPlan(served, null, null);', context);
      return els.get('operating-surface-body').innerHTML;
    },
    rerender(js) { return vm.runInContext(`${js}; budgetSurfaceHtml(__ctx)`, context); },
  };
}


const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const todaySection = html => {
  const start = html.indexOf('data-budget-surface-section="today"');
  return html.slice(start, html.indexOf('<!--budget-current-position-end-->', start));
};
// The sheet block for one named cost, up to the next cost heading.
const costBlock = (sheet, label) => {
  const at = sheet.indexOf(label);
  if (at < 0) return '';
  const rest = sheet.slice(at + label.length);
  const next = rest.search(/ (?:School trip|Winter tires) /);
  return label + (next < 0 ? rest : rest.slice(0, next));
};

console.log('\n=== the sheet and the published pay periods agree ===');
{
  const p = page();
  const html = p.render(fx.served());
  const ctx = p.context.__ctx;
  const periods = ctx.advice.payPeriodViews;
  const published = (role, id) => periods.find(row => row.timelineRole === role).plannedCostFunding.items.find(item => item.id === id).contribution;
  const next = periods.find(row => row.timelineRole === 'next');
  const byStart = (start, id) => periods.find(row => row.start === start).plannedCostFunding.items.find(item => item.id === id).contribution;
  // Hand-written control: the invented costs (400 + 900) and the first full
  // period's published split, which is not the whole 400 the sheet used to print.
  const schoolNext = published('next', 'school-trip');
  ok(next.start === '2026-08-28' && schoolNext > 0 && schoolNext < 400,
    'Forecast publishes a split for the Aug 28 period, not the whole $400 (control)', String(schoolNext));
  const sheet = text(todaySection(html));
  ok(/Nest Money funding plan — August 28 payday/.test(sheet), 'the sheet is labelled with the Aug 28 payday');
  const school = costBlock(sheet, 'School trip');
  ok(school.includes(money(schoolNext)) && !school.includes('$400.00 estimate School trip') && !/School trip \$400\.00 estimate/.test(school),
    'the sheet prints the published School trip contribution for Aug 28 (' + money(schoolNext) + ')', school.slice(0, 160));
  ok(!/Nest Money funding plan — August 28 payday \$400\.00/.test(sheet),
    'the payday total is not the old whole-cost $400.00');
  // The headline contribution equals the published period contribution.
  ok(new RegExp('Nest Money funding plan — August 28 payday ' + money(next.plannedCostFunding.contribution).replace(/[$.]/g, '\\$&')).test(sheet),
    'the sheet total equals the published Aug 28 period contribution', sheet.slice(sheet.indexOf('Nest Money'), sheet.indexOf('Nest Money') + 120));
  // Winter tires: no funding this payday, and its next scheduled contribution
  // is the published one for the later period that carries it.
  const tires = costBlock(sheet, 'Winter tires');
  const tiresNext = byStart('2026-09-25', 'winter-tires');
  ok(/No funding from this payday/.test(tires) && published('next', 'winter-tires') === 0,
    'Winter tires receives nothing this payday, as published');
  ok(tires.includes('Next scheduled contribution ' + money(tiresNext)) && /on September 25/.test(tires),
    'its next scheduled contribution is the published Sep 25 period contribution (' + money(tiresNext) + ')', tires.slice(0, 220));
  // Every published payday row of the schedule equals its period's contribution.
  const schedule = periods.find(row => row.timelineRole === 'current').paydaySchedule;
  const rows = schedule.paydays.filter(row => periods.some(period => period.start === row.payday && period.plannedCostFunding.status === 'ready'));
  ok(schedule.status === 'ready' && rows.length >= 6 && rows.every(row =>
    Math.round(row.contribution * 100) === Math.round(periods.find(period => period.start === row.payday).plannedCostFunding.contribution * 100)),
    'every payday row of the published schedule equals its period contribution (' + rows.length + ' rows)');
  // The page selects what Forecast published; it runs no funding chain of its own.
  const names = ['simulate', 'fundingSequence', 'majorPlans', 'paydayAllocation', 'planSpendPaydayFunding'];
  const originals = Object.fromEntries(names.map(name => [name, F[name]]));
  let calls = 0;
  for (const name of names) F[name] = (...args) => { calls++; return originals[name](...args); };
  let selected;
  try { selected = vm.runInContext('budgetMonthPlanSpendSchedule(__ctx)', p.context); } finally { Object.assign(F, originals); }
  ok(calls === 0, 'the page starts no funding walk to produce the sheet schedule', calls + ' call(s)');
  ok(JSON.stringify(selected) === JSON.stringify(schedule), 'the sheet schedule is exactly the published current-period schedule');
  // Fail closed: with the publication removed the sheet shows unavailable, not a recomputed plan.
  const gone = p.rerender(`delete ${'__ctx.advice.payPeriodViews.find(row => row.timelineRole === "current")'}.paydaySchedule`);
  const goneSheet = text(todaySection(gone));
  ok(/Nest Money funding plan[\s\S]{0,80}unavailable/i.test(goneSheet) && !/School trip/.test(goneSheet.slice(goneSheet.indexOf('Nest Money'))),
    'no published schedule: the sheet is unavailable, never a page-computed plan');
}

console.log('\n=== withheld funding is withheld in both places ===');
{
  const p = page();
  const html = p.render(fx.served({ withUndatedCost: true }));
  const ctx = p.context.__ctx;
  const periods = ctx.advice.payPeriodViews;
  const schedule = periods.find(row => row.timelineRole === 'current').paydaySchedule;
  ok(periods.filter(row => row.timelineRole !== 'past').every(row => row.plannedCostFunding.status === 'unavailable')
    && schedule.status === 'unavailable' && schedule.paydays.length === 0,
    'an undated planned cost withholds every period funding and the schedule alike');
  const sheet = text(todaySection(html));
  ok(/Nest Money funding plan[\s\S]{0,60}unavailable/i.test(sheet) && !/Nest Money funding plan — /.test(sheet),
    'the sheet prints no payday plan while Forecast withholds it');
}

console.log('\n=== a payday that is today still prints its plan ===');
{
  // Same invented household with the payroll anchor moved so Aug 20 is itself a payday:
  // the schedule's first row is the live date, which the page reads row trust for.
  const data = fx.served();
  data.plan.income[0].anchor = '2026-08-20';
  const p = page();
  const html = p.render(data);
  const periods = p.context.__ctx.advice.payPeriodViews;
  const schedule = periods.find(row => row.timelineRole === 'current').paydaySchedule;
  const first = schedule.paydays[0];
  const own = periods.find(row => row.start === first.payday).plannedCostFunding;
  ok(schedule.status === 'ready' && first.payday === schedule.asOf && own.status === 'ready',
    'control: the schedule is ready and its first payday is today', schedule.status + ' ' + first.payday + ' ' + schedule.asOf);
  ok(['calculated', 'estimated'].includes(first.trust) && first.trust === own.trust,
    'the live-date row carries the period\'s published trust, not null', String(first.trust));
  const sheet = text(todaySection(html));
  ok(/Nest Money funding plan — August 20 payday/.test(sheet) && !/Nest Money funding plan[\s\S]{0,40}unavailable/i.test(sheet),
    'the sheet prints the payday plan for a payday that is today', sheet.slice(sheet.indexOf('Nest Money'), sheet.indexOf('Nest Money') + 140));
}

if (failures) { console.log(`\n${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('\nALL CHECKS PASSED');
