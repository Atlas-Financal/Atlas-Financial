'use strict';
// The active Budget renderer, end to end: invented household -> real
// observation/overlay -> real renderPlan -> #operating-surface-body.
// Expected figures are worked out here from the fixture's own inputs,
// independently of Forecast.
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

// Independent expectations from the fixture header.
const money = n => '$' + n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const EXPECT = {
  income: 2600 + 1450,
  bills: 1400 + 120 + 60 + 85,
  paid: 1400,
  remaining: 120 + 60 + 85,
  household: 450 + 160 + 120 + 22.99,
  available: 1215 + 160,
  billsAccount: 1215,
  floor: 300,
};
EXPECT.afterBills = EXPECT.income - EXPECT.bills;
EXPECT.final = Math.round((EXPECT.afterBills - EXPECT.household) * 100) / 100;

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
const householdActualUnknown = html => /data-budget-browse-hold[\s\S]*?data-budget-ratio-actual><span class="budget-v3-unknown">Unknown/.test(html);
const householdActualContains = (html, amount) => new RegExp('data-budget-browse-hold[\\s\\S]*?data-budget-ratio-actual>[^<]*\\$'+amount.replace('.', '\\.')+'<').test(html);
const step = (html, n) => {
  const m = new RegExp(`data-operating-question="${n}"[\\s\\S]*?</summary>`).exec(html);
  return m ? text(m[0]) : '';
};
const section = (html, kind) => {
  if (kind === 'period') return html.slice(html.indexOf('<!--budget-current-position-end-->'));
  const start = html.indexOf(`data-budget-surface-section="${kind}"`);
  if (start < 0) return '';
  if (kind === 'today') return html.slice(start, html.indexOf('<!--budget-current-position-end-->', start));
  const next = html.indexOf('data-budget-surface-section="', start + 10);
  return html.slice(start, next < 0 ? html.length : next);
};

console.log('\n=== one active renderer ===');
const p = page();
const html = p.render(fx.served());
console.log('\n=== published window above the compact overview ===');
ok(html.indexOf('data-budget-window-header') < html.indexOf('data-live-current-balance'),
  'the selected window precedes Current balance in the one primary section');
ok((html.match(/data-budget-surface-section="period"/g) || []).length === 1,
  'Current balance and period deductions share one overview card');
// The print-only Balance After Deductions terms row (#549) reprints the
// published closing term exactly once; nothing else may repeat the figure.
// The print-only [data-bad-timeline] list is hidden (hidden + aria-hidden): it
// reprints every period's term for other renderers and is never shown.
const badTimeline = (html.match(/<ol data-bad-timeline hidden aria-hidden="true">[^]*?<\/ol>/) || [''])[0];
const badTermRow = (html.match(/data-bad-term="balanceAfterDeductions"[^]*?<\/div>/) || [''])[0];
ok((html.match(/data-budget-period-result/g) || []).length === 1
  && (html.match(/<ol data-bad-timeline /g) || []).length === 1 && badTimeline
  && (html.replace(badTimeline, '').replace(badTermRow, '').match(/\$1,632\.01/g) || []).length === 1
  && (badTermRow.match(/\$1,632\.01/g) || []).length === 1,
  'the final result is published once at the end, including its expanded evidence');
ok(/data-budget-window-range>Aug 14 – Aug 27</.test(html),
  'the title uses the actual published bounds rather than the This payday label');
ok(/<b>Day 7<\/b> of 14/.test(html) && /Next payday <b>Aug 28<\/b> · in 8 days/.test(html),
  'independent date identity: Aug 20 is day seven of Aug 14–27; Aug 28 is eight days later');
ok((html.match(/data-budget-wheel="period"/g) || []).length === 1
  && /data-budget-window-picker hidden/.test(html), 'one real period wheel is available on demand');
ok(/data-budget-detail-sheet/.test(html) && ['overview', 'spending', 'bills', 'upcoming'].every(key =>
  html.includes(`data-budget-section="${key}"`)), 'the compact section controls and one shared sheet are present');
const dateContext = vm.runInContext(`({ advice: { defaultView: {asOf: '2026-08-20'}, payPeriodViews: [
  {id: 'invented-invalid-dates', start: '2026-02-30', end: '2026-03-12', timelineRole: 'current'}] } })`, p.context);
p.context.dateContext = dateContext;
const missingDates = vm.runInContext('budgetWindowHeaderHtml(dateContext)', p.context);
ok(/Date progress unavailable/.test(missingDates) && !/<b>Day /.test(missingDates),
  'invalid dates withhold progress rather than normalizing into a fictitious day');
const missingAsOf = vm.runInContext(`dateContext.advice.payPeriodViews[0].start = '2026-08-14';
  dateContext.advice.payPeriodViews[0].end = '2026-08-27'; dateContext.asOf = '2026-08-20';
  dateContext.advice.defaultView.asOf = null; budgetWindowHeaderHtml(dateContext)`, p.context);
ok(/Date progress unavailable/.test(missingAsOf) && !/<b>Day /.test(missingAsOf),
  'an explicitly missing published as-of does not fall back to another date');
ok(/data-budget-surface="pay-period"/.test(html), 'renderPlan mounts the active Budget surface in pay-period view');
ok(p.context.__retainedCalls === 0, 'the retained operatingSurfaceHtml is not called on the page path',
  `${p.context.__retainedCalls} call(s)`);
ok(!/data-budget-more-views|data-current-payday-details/.test(html),
  'the old "More Budget views" and "Current payday details" disclosures are not rendered');
ok((html.match(/data-calendar-waterfall="/g) || []).length === 1, 'exactly one pay-period waterfall is printed');
const hero = text(/data-budget-period-result[\s\S]*?<\/div>/.exec(html)?.[0] || '');
ok(hero.includes(money(EXPECT.final)) && /estimated/.test(hero) && !/Before savings|After proposed funding/.test(step(html, '07')),
  'the overview republishes the independently reconciled final balance and its estimate qualifier without a visible subtitle');
const bar = id => /style="left:([^%]+)%;width:([^%]+)%"/.exec(
  html.split(`data-operating-question="${id}"`)[1]?.split('</summary>')[0] || '');
ok(bar('02') && Number(bar('02')[1]) === 0 && Math.abs(Number(bar('02')[2]) - 2600 / 4050 * 100) < 1e-9,
  'income progress uses confirmed received 2600 / original planned 4050');
ok(!bar('04') && /partial evidence/.test(step(html, '04')) && /1,400\.00[\s\S]*?1,665\.00/.test(step(html, '04')),
  'paid 1400 / original bill plan 1665 stays partial with unverified Hydro; no complete bar');
ok(bar('07') && Math.abs(Number(bar('07')[2]) - EXPECT.final / EXPECT.income * 100) < 1e-9,
  'the final bar keeps the income scale rather than rescaling the ending balance');
ok(!bar('savings') && !/budget-waterfall-track|budget-progress-track/.test(
  html.split('data-operating-question="savings"')[1]?.split('</summary>')[0] || '')
  && /Unavailable/.test(step(html, 'savings')),
  'unavailable savings stock stays unknown with no deduction geometry or invented zero');

console.log('\n=== pay-period waterfall on the active surface ===');
console.log('\n=== published category bars and grouped bills ===');
const categoryBrowse = (output, id) => output.split(`data-budget-category-open="${id}" data-budget-browse-origin="spending"`)[1]?.split('</button>')[0] || '';
ok(/308\.55[\s\S]*?\/[\s\S]*?450\.00/.test(categoryBrowse(html, 'groceries'))
  && text(categoryBrowse(html, 'groceries')).includes('$141.45 left'),
  'the default grocery row uses independently observed 212.40 + 96.15 and published remaining 141.45');
const categoryFill = /budget-category-fill" style="width:([^%]+)%/.exec(categoryBrowse(html, 'groceries'));
ok(categoryFill && Math.abs(Number(categoryFill[1]) - 308.55 / 450 * 100) < 1e-9,
  'category geometry uses spent/plan rather than a new reserve amount');
ok(/data-budget-browse-hold[\s\S]*?444\.49[\s\S]*?730\.00/.test(html)
  && /data-budget-browse-remaining[\s\S]*?308\.50/.test(html),
  'spent 444.49 / original plan 730 includes Other once; dated remaining stays separate');
ok(/data-budget-bill-bucket="due"[\s\S]*?data-budget-bill-open="card-minimum"/.test(html)
  && /To confirm[\s\S]*?data-budget-bill-open="hydro"/.test(html),
  'upcoming and unverified bill occurrences remain separate without inferring unpaid status');
ok(/budget-browse-paid[\s\S]*?data-budget-bill-open="mortgage"/.test(html)
  && /data-budget-browse-bills-remaining[\s\S]*?265\.00/.test(html),
  'paid occurrence stays in its bucket while the header reprints Forecast remaining bills 265');
ok((html.match(/data-budget-bill-filter=/g) || []).length === 4
  && /data-budget-bill-filter="all"[\s\S]*?All<span>4<\/span>/.test(html)
  && /data-budget-bill-filter="check"[\s\S]*?To confirm<span>1<\/span>/.test(html)
  && /data-budget-bill-filter="due"[\s\S]*?Due<span>2<\/span>/.test(html)
  && /data-budget-bill-filter="paid"[\s\S]*?Paid<span>1<\/span>/.test(html),
  'filters count all four original occurrences and preserve their distinct published states');
const noSpent = p.rerender("__ctx.advice.payPeriodViews.find(row=>row.timelineRole==='current').householdBudget[0].spent = null");
{
  const bp = page(); bp.render(fx.served());
  const source = JSON.stringify([
    { id: 'synthetic-paid', label: 'Synthetic paid', status: 'PAID', settlement: 'represented', date: '2026-08-15' },
    { id: 'synthetic-due', label: 'Synthetic due', status: 'still due', settlement: 'upcoming', date: '2026-08-21' },
    { id: 'synthetic-pending', label: 'Synthetic pending', status: 'pending', settlement: 'pending', date: '2026-08-19' },
    { id: 'synthetic-unverified', label: 'Synthetic unverified', status: 'planned', settlement: 'unverified', date: '2026-08-18' },
    { id: 'synthetic-unknown', label: 'Synthetic unknown', status: null, settlement: null, date: '2026-08-17' },
    { id: 'synthetic-contradiction', label: 'Synthetic contradiction', status: 'PAID', settlement: 'unverified', date: '2026-08-16' },
  ]);
  const out = vm.runInContext(`globalThis.__filterRows = ${source}; globalThis.__beforeRows = JSON.stringify(__filterRows);
    budgetBillsSectionHtml({bills: __filterRows}, __ctx)`, bp.context);
  ok(/All<span>6<\/span>/.test(out) && /Paid<span>1<\/span>/.test(out)
    && /To confirm<span>2<\/span>/.test(out) && /Due<span>1<\/span>/.test(out)
    && /Pending<span>1<\/span>/.test(out) && /Unknown<span>1<\/span>/.test(out),
    'filter counts use the exact published roster; pending, unknown and contradictory confirmation never become paid');
  const bucket = key => out.split(`data-budget-bill-bucket="${key}"`)[1]?.split('</div>')[0] || '';
  ok(bucket('due').includes('data-budget-bill-open="synthetic-due"')
    && bucket('pending').includes('data-budget-bill-open="synthetic-pending"')
    && bucket('check').includes('data-budget-bill-open="synthetic-unverified"')
    && bucket('check').includes('data-budget-bill-open="synthetic-contradiction"')
    && bucket('unknown').includes('data-budget-bill-open="synthetic-unknown"')
    && !bucket('due').includes('synthetic-pending') && !bucket('due').includes('synthetic-unknown')
    && /Payment pending/.test(out) && /To confirm/.test(out) && /Status unavailable/.test(out),
    'every published state keeps its own bucket; pending and unknown never become Due');
  ok(vm.runInContext('JSON.stringify(__filterRows) === __beforeRows', bp.context), 'filter presentation never rewrites settlement evidence');
  const statusCases = [
    [{status:'still due',settlement:'upcoming',date:'2026-08-21'}, 'due', 'Due', ''],
    [{status:'planned',settlement:'upcoming',date:'2026-08-21'}, 'due', 'Due', ''],
    [{status:'still due',settlement:'unverified',date:'2026-08-18'}, 'check', 'To confirm', ''],
    [{status:'overdue',settlement:'upcoming',date:'2026-08-21'}, 'due', 'Not paid', ''],
    [{status:'not-paid',settlement:'upcoming',date:'2026-08-21'}, 'due', 'Not paid', ''],
    [{status:'still due',settlement:'upcoming',date:'2026-02-30'}, 'due', 'Not paid', ''],
    [{status:'still due',settlement:'upcoming'}, 'due', 'Not paid', ''],
    [{status:'unknown',settlement:'upcoming',date:'2026-08-21'}, 'unknown', 'Status unavailable', ''],
    [{status:'pending',settlement:'upcoming',date:'2026-08-21'}, 'pending', 'Payment pending', ''],
    [{status:'needs-date',settlement:'upcoming',date:'2026-08-21'}, 'check', 'Needs a date', ''],
    [{status:'still due',settlement:'upcoming',date:'2026-08-21',cashPaymentStatus:'sent',householdPaymentStatus:'partial'}, 'check', 'Not paid', 'Partial payment sent'],
    [{status:'planned',settlement:'upcoming',date:'2026-08-21',cashPaymentStatus:'sent',householdPaymentStatus:'paid'}, 'due', 'Planned', 'Money sent'],
    [{status:'still due',settlement:'unverified',date:'2026-08-18',cashPaymentStatus:'sent',householdPaymentStatus:'unconfirmed'}, 'check', 'To confirm', 'Payment allocation unconfirmed'],
    [{status:'still due',settlement:'upcoming',date:'2026-08-21',cashPaymentStatus:'sent'}, 'due', 'Not paid', ''],
  ];
  for (const [row, kind, label, qualifier] of statusCases) {
    const actual = vm.runInContext(`budgetBillPresentation(${JSON.stringify(row)})`, bp.context);
    const rendered = vm.runInContext(`budgetBillBrowseRowHtml(${JSON.stringify(row)})`, bp.context);
    ok(actual.kind === kind && actual.label === label && (actual.qualifier || '') === qualifier
      && rendered.includes('is-upcoming-due') === (label === 'Due'),
      `published ${row.status}/${row.settlement}: ${label} retains ${qualifier || 'its distinct state'}; only qualified scheduled rows get neutral Due styling`);
  }
  const empty = vm.runInContext('budgetBillsSectionHtml({bills: []}, __ctx)', bp.context);
  ok(/All<span>0<\/span>/.test(empty) && /Paid<span>0<\/span>/.test(empty)
    && /To confirm<span>0<\/span>/.test(empty) && /Due<span>0<\/span>/.test(empty)
    && /No published bills in this filter/.test(empty) && /No bill occurrences published/.test(empty), 'empty filters disclose their roster without inventing financial zeros');
}
ok(/Spending unavailable/.test(categoryBrowse(noSpent, 'groceries'))
  && !/141\.45 left|budget-category-fill/.test(categoryBrowse(noSpent, 'groceries')),
  'unavailable spending is not classified within plan, replaced by zero or given a numeric bar');
p.render(fx.served());
const noPlan = p.rerender("__ctx.advice.payPeriodViews.find(row=>row.timelineRole==='current').householdBudget[0].planned = null");
ok(/is-hatched/.test(categoryBrowse(noPlan, 'groceries')) && /data-budget-category-scale="unavailable"/.test(categoryBrowse(noPlan, 'groceries'))
  && !/budget-category-fill/.test(categoryBrowse(noPlan, 'groceries')) && /308\.55/.test(categoryBrowse(noPlan, 'groceries')),
  'missing category plan withholds only ratio geometry while observed spending stays known');
p.render(fx.served());
const noHoldTrust = p.rerender("__ctx.advice.payPeriodViews.find(row=>row.timelineRole==='current').budgetProgress.household.actual.trust = 'unavailable'");
ok(householdActualUnknown(noHoldTrust),
  'an explicitly unavailable published actual stays unavailable in the new secondary summary');
p.render(fx.served());
const zeroBills = p.rerender("const zero = __ctx.advice.payPeriodViews.find(row=>row.timelineRole==='current').budgetProgress.bills; zero.planned = {amount:0,trust:'calculated',completeness:'complete'}; zero.actual = {amount:0,trust:'calculated',completeness:'complete'}");
ok(/data-budget-bar-state="zero-plan"/.test(zeroBills) && /data-budget-progress-kind="bills"[^>]*aria-hidden="true"><\/span>/.test(zeroBills),
  'known zero bills use an explicit no-scale track rather than an unavailable hatch or a division by zero');
p.render(fx.served());
const unknownBill = p.rerender("Object.assign(__ctx.advice.payPeriodViews.find(row=>row.timelineRole==='current').bills.find(row=>row.id==='hydro'), {status:null,settlement:null})");
ok(/Status unavailable[\s\S]*?data-budget-bill-open="hydro"/.test(unknownBill),
  'a bill with no published settlement remains in the unknown group rather than being inferred due or paid');
p.render(fx.served());
const stampedHold = p.rerender("__ctx.advice.payPeriodViews.find(row=>row.timelineRole==='current').budgetProgress.household.actual.amount = 612.34");
ok(householdActualContains(stampedHold, '612.34'),
  'the actual summary selects its publication without summing category rows or borrowing the reserve');
for (const change of ["remainingHousehold = null", "currentThrough = '2026-09-10'", "asOf = '2026-08-19'", "trust = 'unavailable'"]) {
  p.render(fx.served());
  const result = p.rerender(`__ctx.advice.payPeriodViews.find(row=>row.timelineRole==='current').fromTodayFunding.${change}`);
  ok(/data-budget-browse-remaining[^>]*><span class="budget-browse-unknown">Unavailable/.test(result),
    `${change}: matching current remaining is withheld, never recomputed from categories`);
}
p.render(fx.served());

console.log('\n=== historical spending and bill summaries ===');
const browseCard = (output, kind) => {
  const start = output.indexOf(`data-budget-browse="${kind}"`);
  if (start < 0) return '';
  const from = output.slice(start);
  const end = from.indexOf('</section>');
  return from.slice(0, end < 0 ? from.length : end);
};
const selectPublishedPeriod = (pageObj, start) => pageObj.rerender(
  `planPayPeriodId = String((__ctx.advice.payPeriodViews.find(item => item.start === ${JSON.stringify(start)}) || {}).id || ${JSON.stringify(start)});
   __ctx.planPayPeriodId = planPayPeriodId`);
ok(/data-budget-spending-evidence="current"/.test(html)
  && /0 of 3 known categories over plan/.test(html)
  && /data-budget-bills-remaining-scope="actionable"/.test(html)
  && /data-budget-browse-bills-remaining[\s\S]*?265\.00/.test(html)
  && /left to pay or confirm/.test(browseCard(html, 'bills')),
  'current remaining 265 and the known-category count stay on the live period');
const unavailableHistory = selectPublishedPeriod(p, '2026-07-31');
const unavailableSpend = browseCard(unavailableHistory, 'spending');
ok(/data-budget-spending-evidence="unavailable"/.test(unavailableSpend)
  && /Spending unavailable · completed period/.test(unavailableSpend)
  && !/Observed spending · completed period/.test(unavailableSpend)
  && householdActualUnknown(unavailableSpend)
  && /Missing or incomplete history is not treated as observed spending/.test(unavailableSpend)
  && ['groceries', 'fuel', 'restaurants'].every(id => /Spending unavailable/.test(categoryBrowse(unavailableHistory, id))),
  'Jul 31–Aug 13 omitted observations stay unavailable, not counted $0 observed history');
p.render(fx.served());
const partialHistory = p.rerender(`
  (__ctx.advice.payPeriodViews.find(item => item.start === '2026-07-31').householdBudget.find(item => item.id === 'groceries')).spent = 80;
  (__ctx.advice.payPeriodViews.find(item => item.start === '2026-07-31').householdBudget.find(item => item.id === 'fuel')).spent = null;
  (__ctx.advice.payPeriodViews.find(item => item.start === '2026-07-31').householdBudget.find(item => item.id === 'restaurants')).spent = null;
  __ctx.advice.payPeriodViews.find(item => item.start === '2026-07-31').budgetHold = 80;
  planPayPeriodId = 'past:2026-07-31'; __ctx.planPayPeriodId = planPayPeriodId`);
const partialSpend = browseCard(partialHistory, 'spending');
ok(/data-budget-spending-evidence="partial"/.test(partialSpend)
  && /Incomplete spending evidence · completed period/.test(partialSpend)
  && !/Observed spending · completed period/.test(partialSpend)
  && householdActualUnknown(partialSpend)
  && !/data-budget-browse-hold[^>]*>\$80\.00</.test(partialSpend)
  && /80\.00[\s\S]*?\//.test(categoryBrowse(partialHistory, 'groceries')),
  'partial history keeps the observed grocery 80 and withholds an incomplete counted total');
p.render(fx.served());
const knownHistory = p.rerender(`
  (__ctx.advice.payPeriodViews.find(item => item.start === '2026-07-31').householdBudget.find(item => item.id === 'groceries')).spent = 80;
  (__ctx.advice.payPeriodViews.find(item => item.start === '2026-07-31').householdBudget.find(item => item.id === 'fuel')).spent = 20;
  (__ctx.advice.payPeriodViews.find(item => item.start === '2026-07-31').householdBudget.find(item => item.id === 'restaurants')).spent = 10;
  __ctx.advice.payPeriodViews.find(item => item.start === '2026-07-31').budgetHold = 110;
  // Independently stamped publication-boundary identity, not an observation proof.
  __ctx.advice.payPeriodViews.find(item => item.start === '2026-07-31').budgetProgress.household.actual = {amount:110,trust:'calculated',completeness:'complete'};
  planPayPeriodId = 'past:2026-07-31'; __ctx.planPayPeriodId = planPayPeriodId`);
const knownSpend = browseCard(knownHistory, 'spending');
ok(/data-budget-spending-evidence="observed"/.test(knownSpend)
  && /Observed spending · completed period/.test(knownSpend)
  && householdActualContains(knownSpend, '110.00')
  && /Completed periods show observed spending/.test(knownSpend),
  'complete lookback 80 + 20 + 10 reprints the published 110 counted total');
const hydroPage = page();
hydroPage.render(fx.served({ historicalHydroDay: 5 }));
const hydroLookback = selectPublishedPeriod(hydroPage, '2026-07-31');
const hydroPeriod = hydroPage.context.__ctx.advice.payPeriodViews.find(row => row.start === '2026-07-31');
ok(hydroPeriod && hydroPeriod.remainingBills === 0 && hydroPeriod.totalBillsThisPeriod === 120
  && hydroPeriod.bills.some(row => row.id === 'hydro' && row.date === '2026-08-05'
    && row.settlement === 'unverified' && row.status === 'planned' && row.remaining === 120),
  'Forecast seals Aug 5 Hydro 120 as planned/unverified and keeps historical remaining 0');
const hydroBills = browseCard(hydroLookback, 'bills');
ok(/data-budget-bills-remaining-scope="historical-unconfirmed"/.test(hydroBills)
  && /Settlement not fully confirmed/.test(hydroBills)
  && !/left to pay or confirm/.test(hydroBills)
  && !/\$0\.00/.test(/id="budget-bills-heading"[\s\S]*?<\/h2>/.exec(hydroBills)?.[0] || '')
  && /To confirm<span>1<\/span>/.test(hydroBills)
  && /data-budget-bill-bucket="check"[\s\S]*?data-budget-bill-open="hydro"[\s\S]*?120\.00[\s\S]*?To confirm/.test(hydroBills)
  && /data-period-bill="hydro"[\s\S]*?Missing evidence does not mean unpaid/.test(hydroLookback),
  'unverified historical Hydro withholds the actionable $0 heading and keeps original evidence');
const paidHistory = hydroPage.rerender(`
  Object.assign(__ctx.advice.payPeriodViews.find(item => item.start === '2026-07-31').bills.find(item => item.id === 'hydro'), {status:'PAID',settlement:'represented',remaining:0});
  Object.assign(__ctx.advice.payPeriodViews.find(item => item.start === '2026-07-31'), {paidBills:120, remainingBills:0});`);
const paidBills = browseCard(paidHistory, 'bills');
ok(/data-budget-bills-remaining-scope="historical-settlement"/.test(paidBills)
  && /Completed-period bills/.test(paidBills)
  && !/data-budget-browse-bills-remaining|left to pay or confirm/.test(paidBills)
  && /\$120\.00 confirmed settled</.test(paidBills)
  && /budget-browse-paid[\s\S]*?data-budget-bill-open="hydro"/.test(paidBills)
  && !/data-budget-bill-bucket="check"/.test(paidBills),
  'paid historical Hydro keeps its published paid amount and no false confirm group; its header stays historical');
const unknownHistory = hydroPage.rerender(`
  Object.assign(__ctx.advice.payPeriodViews.find(item => item.start === '2026-07-31').bills.find(item => item.id === 'hydro'), {status:null,settlement:null,remaining:120});
  Object.assign(__ctx.advice.payPeriodViews.find(item => item.start === '2026-07-31'), {paidBills:0, remainingBills:0});`);
const unknownBills = browseCard(unknownHistory, 'bills');
ok(/data-budget-bills-remaining-scope="historical-unconfirmed"/.test(unknownBills)
  && /Settlement not fully confirmed/.test(unknownBills)
  && !/left to pay or confirm/.test(unknownBills)
  && /Status unavailable[\s\S]*?data-budget-bill-open="hydro"/.test(unknownBills)
  && /Unknown<span>1<\/span>/.test(unknownBills),
  'unknown historical settlement withholds the $0 all-clear and does not infer unpaid');
const restoredCurrent = hydroPage.rerender(`
  planPayPeriodId = null; __ctx.planPayPeriodId = null`);
ok(/data-budget-spending-evidence="current"/.test(restoredCurrent)
  && /data-budget-browse-bills-remaining[\s\S]*?145\.00/.test(restoredCurrent)
  && /left to pay or confirm/.test(browseCard(restoredCurrent, 'bills'))
  && /0 of 3 known categories over plan/.test(restoredCurrent),
  'moving Hydro to Aug 5 leaves current remaining 60+85=145 on the live contract');
p.render(fx.served());
const nextProjected = p.context.__ctx.advice.payPeriodViews.find(row => row.timelineRole === 'next');
const nextBrowse = p.rerender(`planPayPeriodId = ${JSON.stringify(String(nextProjected.id || nextProjected.start))}; __ctx.planPayPeriodId = planPayPeriodId`);
ok(/data-budget-spending-evidence="projected"/.test(nextBrowse)
  && /Projected plan · spending not observed/.test(browseCard(nextBrowse, 'spending'))
  && /data-budget-bills-remaining-scope="actionable"/.test(nextBrowse),
  'the next payday still uses projected spending wording and the published remaining scope');
p.rerender('planPayPeriodId = null; __ctx.planPayPeriodId = null');

ok(step(html, '02').includes(money(EXPECT.income)) && /≈ estimated/.test(step(html, '02')),
  `Income is ${money(EXPECT.income)} with Forecast's estimated tag`, step(html, '02'));
ok(step(html, '04').includes(money(EXPECT.bills)), `Bills deduction is ${money(EXPECT.bills)}`, step(html, '04'));
ok(step(html, '05').includes(money(EXPECT.afterBills)), `Balance after bills is ${money(EXPECT.afterBills)}`, step(html, '05'));
ok(step(html, '06').includes('$444.49') && step(html, '06').includes('$730.00'), 'Household actual/original plan is 444.49 / 730.00', step(html, '06'));
ok(p.context.__ctx.advice.payPeriodViews.find(row=>row.timelineRole==='current').budgetHold === EXPECT.household, 'native financial reserve remains independently reconciled 752.99');
ok(step(html, '07').includes(money(EXPECT.final)) && /≈ estimated/.test(step(html, '07')),
  `Balance After Deductions is ${money(EXPECT.final)}, estimated`, step(html, '07'));
ok(/Savings[\s\S]*?Unavailable/.test(text(html)) && !/Savings[^$]*\$0\.00/.test(step(html, 'savings')),
  'the period savings step with no funding snapshot reads Unavailable, never $0');

console.log('\n=== bills, evidence and spending on the active surface ===');
const t = text(html);
ok(t.includes(`Total bills this period ${money(EXPECT.bills)}`), `total bills are Forecast's ${money(EXPECT.bills)}`);
ok(t.includes(`Paid bills this period ${money(EXPECT.paid)}`), `paid bills are ${money(EXPECT.paid)}`);
ok(t.includes(`Remaining bills to pay ${money(EXPECT.remaining)}`), `remaining bills are ${money(EXPECT.remaining)}`);
ok(/data-period-bill="hydro"[\s\S]*?Missing evidence does not mean unpaid/.test(html),
  'a past-due bill with no linked payment is not called unpaid');
ok(/data-period-bill="mortgage"[\s\S]*?Linked transaction evidence/.test(html),
  'the paid mortgage keeps its linked transaction evidence');
ok(/data-budget-spent="groceries"[\s\S]*?Synthetic grocer[\s\S]*?212\.40[\s\S]*?Synthetic market[\s\S]*?96\.15/.test(html),
  'Groceries opens to its transactions');
ok(/data-other-spending[\s\S]*?Synthetic general store/.test(html), 'unassigned spending keeps its transaction');

console.log('\n=== signed deficits, overflow and known zero income on the financial path ===');
const summaryHtml = (source, id) => source.split(`data-operating-question="${id}"`)[1]?.split('</summary>')[0] || '';
const segments = source => [...source.matchAll(/class="budget-waterfall-bar([^\"]*)" style="left:([^%]+)%;width:([^%]+)%"/g)]
  .map(match => ({ negative: match[1].includes('is-negative'), left: Number(match[2]), width: Number(match[3]) }));
const deficitHtml = page().render(fx.served({ periodInternet: 1800 }));
// 4,050 income - (1,400 + 120 + 60 + 1,800) bills = 670;
// 670 - 752.99 household = -82.99. Shared axis is [-4,050, +4,050].
ok(step(deficitHtml, '04').includes(money(3380)) && step(deficitHtml, '05').includes(money(670)),
  'synthetic observations produce the independent 3,380 bill load and 670 after bills');
ok(/data-sign="negative"/.test(summaryHtml(deficitHtml, '07')) && /82\.99/.test(step(deficitHtml, '07'))
  && /estimated/.test(step(deficitHtml, '07')), 'the -82.99 final balance keeps its sign and Forecast estimate');
for (const id of ['07']) ok(/data-budget-bar-state="deficit"/.test(summaryHtml(deficitHtml, id))
  && !/is-unknown/.test(summaryHtml(deficitHtml, id)), `${id}: a known negative start or amount is a deficit, never unknown`);
const incomeSegments = segments(summaryHtml(deficitHtml, '02'));
ok(incomeSegments.length === 1 && incomeSegments[0].left === 0 && Math.abs(incomeSegments[0].width - 2600 / 4050 * 100) < 1e-9,
  'received/original-plan income progress remains independent of a deficit balance');
const householdSegments = segments(summaryHtml(deficitHtml, '06'));
ok(householdSegments.length === 1 && householdSegments[0].left === 0 && !householdSegments[0].negative
  && Math.abs(householdSegments[0].width - 444.49 / 730 * 100) < 1e-9,
  'incurred/original-plan household progress stays independent of the reserve deduction and balance sign');
const overflowHtml = page().render(fx.served({ periodInternet: 10000 }));
ok(/is-overflow-start/.test(summaryHtml(overflowHtml, '07')) && /8,282\.99/.test(step(overflowHtml, '07'))
  && !/is-unknown/.test(summaryHtml(overflowHtml, '07')),
  'known -8,282.99 beyond the -4,050 axis gets signed overflow, not an unavailable hatch');
const zeroIncomeHtml = page().render(fx.served({ zeroIncome: true }));
ok(step(zeroIncomeHtml, '02').includes(money(0)) && !/Unavailable/.test(step(zeroIncomeHtml, '02')),
  'no invented salary receipt: zero income remains a published known zero');
for (const id of ['05', '07']) ok(/data-budget-bar-state="zero-income"/.test(summaryHtml(zeroIncomeHtml, id))
  && !/is-unknown/.test(summaryHtml(zeroIncomeHtml, id)) && segments(summaryHtml(zeroIncomeHtml, id)).length === 0,
  `${id}: zero income disables ratio geometry explicitly, without dividing by zero or changing trust`);
ok(/data-sign="negative"/.test(summaryHtml(zeroIncomeHtml, '07')) && /2,417\.99/.test(step(zeroIncomeHtml, '07')),
  'zero-income deficit independently reconciles 0 - 1,665 - 752.99 = -2,417.99');

console.log('\n=== published amount trust is independent of chart scaling ===');
console.log('\n=== real historical Forecast publications never become an actionable all-clear ===');
const browseSection = (out, kind) => out.split(`data-budget-browse="${kind}"`)[1]?.split('</section>')[0] || '';
for (const coverage of ['missing', 'partial', 'truncated', 'full', 'posted-only']) {
  for (const settlement of ['unverified', 'paid']) {
    const historyPage = page(); historyPage.render(fx.historical(coverage, settlement));
    const historicalPeriod = historyPage.context.__ctx.advice.payPeriodViews.find(row => row.start === '2026-07-31');
    ok(historicalPeriod?.lookback === true && historicalPeriod.timelineRole === 'past',
      `${coverage}/${settlement}: actual Forecast publishes the completed Jul 31-Aug 13 identity`);
    if (!historicalPeriod) continue;
    const out = historyPage.rerender(`__ctx.planPayPeriodId = ${JSON.stringify(historicalPeriod.id)}`);
    ok(historicalPeriod.budgetProgress.household.planned.amount === null,
      `${coverage}/${settlement}: current category targets are not original historical plans`);
    const spending = browseSection(out, 'spending'), bills = browseSection(out, 'bills');
    const ready = coverage === 'full' || coverage === 'posted-only';
    const grocery = historicalPeriod.householdBudget.find(row => row.id === 'groceries');
    const fuel = historicalPeriod.householdBudget.find(row => row.id === 'fuel');
    ok(ready ? grocery.spent === 47.25 && fuel.spent === 19.50 && historicalPeriod.budgetHold === 66.75
      : grocery.spent === null && fuel.spent === null && historicalPeriod.budgetHold === 0,
      `${coverage}/${settlement}: real observation coverage publishes independent $47.25 + $19.50 = $66.75, or omits unproven spending`);
    ok(ready ? /Observed spending · completed period/.test(spending) && /\$66\.75/.test(spending)
      : /Spending unavailable · completed period/.test(spending) && !/Observed spending · completed period|Completed periods show observed spending/.test(spending)
        && householdActualUnknown(spending),
      `${coverage}/${settlement}: completed label and historical amount agree with actual coverage, without invented zero spending`);
    const bill = historicalPeriod.bills.find(row => row.id === 'historical-service');
    ok(bill?.status === (settlement === 'paid' ? 'PAID' : 'planned') && historicalPeriod.remainingBills === 0,
      `${coverage}/${settlement}: Forecast historical actionable $0 is retained, with ${settlement} row identity`);
    ok(/Completed-period bills/.test(bills) && !/left to pay or confirm|data-budget-browse-bills-remaining/.test(bills)
      && (settlement === 'paid' ? /data-budget-bill-bucket="paid"[\s\S]*?Synthetic historical service/.test(bills) : /To confirm[\s\S]*?Synthetic historical service/.test(bills))
      && /Historical settlement evidence, not an amount due now/.test(bills),
      `${coverage}/${settlement}: history is settlement evidence, never a zero due/confirmation all-clear`);
    ok(/data-period-bill="historical-service"/.test(out) && /data-budget-category-open="groceries"/.test(out),
      `${coverage}/${settlement}: native bill and transaction evidence stays reachable`);
    const currentOut = historyPage.rerender('__ctx.planPayPeriodId = null');
    const currentRemaining = settlement === 'paid' ? 265 : 370; // 265 current + 105 unresolved earlier bill
    ok(browseSection(currentOut, 'bills').includes(`${money(currentRemaining)}</span> left to pay or confirm`)
      && /known categories over plan/.test(browseSection(currentOut, 'spending')),
      `${coverage}/${settlement}: current view keeps its own ${money(currentRemaining)} action and actual coverage`);
    const future = historyPage.context.__ctx.advice.payPeriodViews.find(row => row.timelineRole === 'next');
    const futureOut = historyPage.rerender(`__ctx.planPayPeriodId = ${JSON.stringify(future.id)}`);
    ok(/Projected plan · spending not observed/.test(browseSection(futureOut, 'spending'))
      && !/Observed spending · completed period|Completed-period bills/.test(futureOut),
      `${coverage}/${settlement}: future remains projected and never borrows historical settlement or observations`);
  }
}
for (const trust of ['unavailable', 'unknown', 'untrusted']) {
  const hp = page(); hp.render(fx.historical('full'));
  const hist = hp.context.__ctx.advice.payPeriodViews.find(row => row.start === '2026-07-31');
  const out = hp.rerender(`__ctx.planPayPeriodId = ${JSON.stringify(hist.id)};
    __ctx.advice.payPeriodViews.find(row => row.start === '2026-07-31').householdBudget.find(row => row.id === 'groceries').trust = ${JSON.stringify(trust)};
    __ctx.advice.payPeriodViews.find(row => row.start === '2026-07-31').budgetProgress.household.actual.trust = ${JSON.stringify(trust)}`);
  ok(/Incomplete spending evidence · completed period/.test(browseSection(out, 'spending'))
    && householdActualUnknown(out)
    && /Spending unavailable/.test(categoryBrowse(out, 'groceries'))
    && !/budget-category-fill|\$47\.25/.test(categoryBrowse(out, 'groceries')),
    `${trust}: partial historical publication withholds the aggregate and affected row geometry; trusted other observations remain`);
  ok(/\$19\.50/.test(categoryBrowse(out, 'fuel')) && /\$105\.00/.test(browseSection(out, 'bills')),
    `${trust}: a category trust failure does not erase separate fuel or bill evidence`);
}
const historicalZero = page(); historicalZero.render(fx.historical('full'));
const withheldOther = historicalZero.rerender(`__ctx.planPayPeriodId = __ctx.advice.payPeriodViews.find(row => row.start === '2026-07-31').id;
  __ctx.advice.payPeriodViews.find(row => row.start === '2026-07-31').householdBudget.push({ id:'other-spending',
    label:'Synthetic unknown historical other spending', otherSpending:true, needsConfirmation:true, spent:null, planned:null });
  __ctx.advice.payPeriodViews.find(row => row.start === '2026-07-31').budgetProgress.household.actual = {amount:null,trust:'unavailable',completeness:'unavailable'}`);
ok(/data-budget-spending-evidence="partial"/.test(browseSection(withheldOther, 'spending'))
  && householdActualUnknown(withheldOther)
  && /Unavailable/.test(categoryBrowse(withheldOther, 'other-spending')),
  'missing Other spending evidence cannot be omitted to promote the full historical hold to observed');
historicalZero.render(fx.historical('full'));
const allZero = historicalZero.rerender(`__ctx.planPayPeriodId = __ctx.advice.payPeriodViews.find(row => row.start === '2026-07-31').id;
  const histZero = __ctx.advice.payPeriodViews.find(row => row.start === '2026-07-31');
  histZero.householdBudget.forEach(row => row.spent = 0); histZero.budgetHold = 0;
  histZero.budgetProgress.household.actual = {amount:0,trust:'calculated',completeness:'complete'}`);
ok(/Observed spending · completed period/.test(browseSection(allZero, 'spending'))
  && householdActualContains(allZero, '0.00'),
  'published known zero observations stay known; missing evidence never fills them');
for (const role of ['current', 'next']) for (const trust of ['unknown', 'unavailable', 'untrusted']) {
  const tp = page(); tp.render(fx.served());
  const period = tp.context.__ctx.advice.payPeriodViews.find(row => row.timelineRole === role);
  const out = tp.rerender(`__ctx.planPayPeriodId = ${JSON.stringify(period.id)};
    __ctx.advice.payPeriodViews.find(row => row.timelineRole === ${JSON.stringify(role)}).householdBudget.find(row => row.id === 'groceries').trust = ${JSON.stringify(trust)}`);
  const card = categoryBrowse(out, 'groceries');
  ok(/Unavailable/.test(card) && !/budget-category-fill|308\.55|141\.45 left/.test(card),
    `${role}/${trust}: explicit category trust failure keeps amounts and ratio geometry unavailable on every active scope`);
  ok(role === 'current' ? /0 of 2 known categories over plan/.test(browseSection(out, 'spending'))
    : /Projected plan · spending not observed/.test(browseSection(out, 'spending')),
    `${role}/${trust}: truthful known-category count or projected label remains independent of history`);
}
// Fault injection at the Forecast publication boundary, through the active
// composer. The observation/Forecast regressions above reconcile real figures;
// this matrix checks that a missing ratio denominator cannot change their trust.
const matrixPage = page();
matrixPage.render(fx.served());
const publishedRow = '__ctx.advice.payPeriodViews.find(row => row.start === "2026-08-14")';
const matrix = (amount, amountTrust, income, incomeTrust, position = 0) => matrixPage.rerender(`
  Object.assign(${publishedRow}, { budgetHold: ${amount}, budgetHoldTrust: ${JSON.stringify(amountTrust)},
    afterBills: ${amount}, afterBillsTrust: ${JSON.stringify(amountTrust)},
    predictedEndingBalance: ${amount}, afterHouseholdBudget: ${amount},
    balanceAfterDeductionsTrust: ${JSON.stringify(amountTrust)},
    available: ${income}, incomeTrust: ${JSON.stringify(incomeTrust)} })`);
for (const trust of ['calculated', 'estimated', null]) for (const amount of [100, 0, -100]) {
  for (const income of [4050, 0]) {
    const result = matrix(amount, trust, income, trust || 'calculated', amount < 0 ? -100 : 0);
    for (const id of ['05', '07']) {
      const row = summaryHtml(result, id);
      ok(trust === null && id === '05' ? /is-unknown|Unavailable/.test(row) && segments(row).length === 0
        : !/is-unknown|Unavailable/.test(row) && /data-budget-bar-state=/.test(row)
          && (income !== 0 || /data-budget-bar-state="zero-income"/.test(row)),
      `${trust} amount ${amount}, income ${income}, row ${id}: known money survives scale availability`);
    }
    const hero = text(/data-budget-period-result[\s\S]*?<\/div>/.exec(result)?.[0] || '');
    ok(!/Unavailable/.test(hero) && hero.includes(Math.abs(amount).toFixed(2)),
      `${trust} amount ${amount}, income ${income}: result hero agrees with row trust`);
  }
  for (const [income, incomeTrust] of [['null', 'unavailable'], ['NaN', 'calculated'],
    ['Infinity', 'estimated'], [4050, 'unknown'], [4050, 'untrusted'], [-4050, 'calculated']]) {
    const result = matrix(amount, trust, income, incomeTrust);
    for (const id of ['05', '07']) ok(trust === null && id === '05'
      ? /is-unknown|Unavailable/.test(summaryHtml(result, id)) && segments(summaryHtml(result, id)).length === 0
      : /data-budget-bar-state="unscaled"/.test(summaryHtml(result, id)) && !/is-unknown|Unavailable/.test(summaryHtml(result, id)),
    `${trust} amount ${amount}, denominator ${income}/${incomeTrust}, row ${id}: scale unavailable, money known`);
  }
  for (const position of ['null', 'NaN', 'Infinity']) {
    const result = matrix(amount, trust, 4050, 'calculated', position);
    ok(/data-budget-bar-state="known"/.test(summaryHtml(result, '06'))
      && !/is-unknown|Unavailable/.test(summaryHtml(result, '06')),
    `${trust} amount ${amount}, position ${position}: missing chart position cannot withhold known money`);
  }
}
for (const amount of [100, 0, -100, 'null', 'NaN', 'Infinity', '"100"']) {
  for (const trust of ['unavailable', 'unknown', 'untrusted']) {
    const result = matrix(amount, trust, 4050, 'calculated');
    for (const id of ['05', '07']) ok(/is-unknown/.test(summaryHtml(result, id))
      && /Unavailable/.test(summaryHtml(result, id)) && segments(summaryHtml(result, id)).length === 0,
    `${amount}/${trust}, row ${id}: unpublished money is withheld with no numeric bar`);
    ok(/Unavailable/.test(text(/data-budget-period-result[\s\S]*?<\/div>/.exec(result)?.[0] || '')),
      `${amount}/${trust}: result hero also withholds unpublished money`);
  }
}
for (const amount of ['NaN', 'Infinity', '"100"']) {
  const result = matrix(amount, 'calculated', 0, 'calculated');
  for (const id of ['05', '07']) ok(/is-unknown/.test(summaryHtml(result, id))
    && /Unavailable/.test(summaryHtml(result, id)), `${amount}/calculated, row ${id}: nonnumeric money stays unknown at zero income`);
}

console.log("\n=== today's money and the next-payday plan ===");
const today = text(section(html, 'today'));
const period = text(section(html, 'period'));
ok(today.includes(`Money available ${money(EXPECT.available)} calculated`), `Money available is ${money(EXPECT.available)}, calculated`, today.slice(0, 200));
ok(today.includes(`Keep at least ${money(EXPECT.floor)} calculated`), `the floor is Forecast's ${money(EXPECT.floor)}, calculated`);
ok(today.includes(`Bills & required minimums ${money(EXPECT.remaining)} estimate`), 'bills still to pay today keep their estimate tag');
ok(/Nest Money funding plan — August 28 payday/.test(today), 'the next-payday plan is in the Today section, labelled with its payday');
ok(/From today · 2026-08-20/.test(period) && !/From today ·/.test(today),
  "today's proposal sits with the period, separate from the next-payday plan");
ok(today.includes(money(EXPECT.billsAccount)) && /Bills account only/.test(today), `Current balance is the published Bills-only ${money(EXPECT.billsAccount)}`);
ok((html.match(/data-live-current-balance-amount/g) || []).length === 1,
  'the Bills-only Current balance is printed once in the active overview');
const currentHero = /data-budget-cash-hero[\s\S]*?<\/p>/.exec(html)?.[0] || '';
ok(currentHero.includes(money(EXPECT.billsAccount)) && !currentHero.includes(money(EXPECT.available)),
  'the prominent Current balance does not aggregate daily-spending cash');
ok(/data-budget-today-evidence[^>]* hidden/.test(html), 'current-position explanations and instructions start folded');
const currentProtection = p.context.__ctx.advice.paydayAllocation.protectedPath;
const keepHtml = /data-budget-cash-keep[\s\S]*?<\/div>/.exec(html)?.[0] || '';
ok(currentProtection.status === 'calculated' && currentProtection.allocated > 300
  && keepHtml.includes(money(currentProtection.allocated)) && /After bills &amp; essentials/.test(keepHtml),
  'Keep republishes current Forecast protection, including future needs beyond the cash floor; it never substitutes the floor');
// Publication-boundary identity proof, independent of the detail-line amount.
// Engine correctness is independently cash-walk reconciled in test-prepare-ahead.
const stampedKeep = p.rerender("__ctx.advice.paydayAllocation.protectedPath = { status: 'calculated', allocated: 456.78 }; __ctx.advice.paydayAllocation.lines = [{ kind: 'future-path', amount: 9999 }]");
const stampedKeepHtml = /data-budget-cash-keep[\s\S]*?<\/div>/.exec(stampedKeep)?.[0] || '';
ok(stampedKeepHtml.includes('$456.78') && !/300\.00|9999|9,999/.test(stampedKeepHtml),
  'Keep uses the authoritative protected-path publication, independently of the floor or incompatible detail-line amounts');
const missingProtection = p.rerender("__ctx.advice.paydayAllocation.protectedPath = { status: 'unavailable', allocated: null }");
ok(/data-budget-cash-keep[\s\S]*?Unavailable/.test(missingProtection)
  && !/data-budget-cash-keep[\s\S]*?<\/div>/.exec(missingProtection)?.[0].includes('$0.00'),
  'unavailable protection stays unavailable, without a zero or cash-floor substitute');
p.render(fx.served());
ok(section(html, 'today').indexOf('data-budget-cash-detail') > section(html, 'today').indexOf('data-budget-today-evidence'),
  'household cash breakdown stays in the info disclosure, outside the permanent overview');
ok(/class="budget-period-info"[\s\S]*data-from-today-proposal[\s\S]*<\/details>/.test(section(html, 'period')),
  'the dated current-cash proposal stays reachable behind period info, distinct from the full-period result');
ok(/data-budget-cash-part="floor"[\s\S]*?calculated[\s\S]*?300\.00/.test(html),
  'the cash floor uses its own published calculated trust, rather than the proposal estimate');
ok(/data-budget-cash-answer[\s\S]*?873\.50[\s\S]*?501\.50/.test(html),
  'Today funding includes dining: (450 - 308.55) + (160 - 74.20) + (120 - 38.75) = 308.50; keep 265 + 308.50 + 300 = 873.50; capacity 1375 - 873.50 = 501.50');
const negativeSpending = page().render(fx.served({ spendingCash: -50, savingsCash: 8000 }));
const negativeHero = /data-budget-cash-hero[\s\S]*?<\/p>/.exec(negativeSpending)?.[0] || '';
ok(negativeHero.includes(money(1215)) && !negativeHero.includes(money(1215 - 50)) && !negativeHero.includes(money(8000)),
  'Current balance remains Bills-only when the daily-spending account is negative and savings are large');
ok(/data-budget-spent="groceries"[\s\S]*?Synthetic grocer[\s\S]*?212\.40/.test(negativeSpending)
  && /data-budget-cash-part="household"[\s\S]*?308\.50/.test(negativeSpending),
  'daily-spending transactions remain household actuals and future obligations despite its negative balance');
const missingBalance = p.rerender("__ctx.advice.defaultView.currentBalancePublication = { accountId: 'chequing-a', amount: null, trust: 'unavailable' }");
ok(/data-budget-cash-hero[^>]*>Unavailable<\/p>/.test(missingBalance),
  'a deliberately unavailable Bills balance is never refilled from another account or the old numeric field');
const missingPublication = p.rerender('__ctx.advice.defaultView.currentBalancePublication = null');
ok(/data-budget-cash-hero[^>]*>Unavailable<\/p>/.test(missingPublication),
  'an explicit null publication also stays unavailable instead of falling back to a duplicate publication');
for (const [accountId, amount, trust] of [['savings-a', 8000, 'posted'], ['chequing-a', '1215', 'posted'],
  ['chequing-a', 1215, 'unavailable']]) {
  const withheld = p.rerender(`__ctx.advice.defaultView.currentBalancePublication = ${JSON.stringify({accountId, amount, trust})}`);
  ok(/data-budget-cash-hero[^>]*>Unavailable<\/p>/.test(withheld),
    `${accountId}/${amount}/${trust}: Current balance withholds wrong identity, nonnumeric or untrusted money`);
}
const unconfirmedBalance = p.rerender("__ctx.advice.defaultView.currentBalancePublication = { accountId: 'chequing-a', amount: 1215, trust: 'planned-unconfirmed' }");
ok(/payday receipt unconfirmed/.test(text(unconfirmedBalance))
  && /budget-cash-est/.test(/data-budget-cash-hero[\s\S]*?<\/p>/.exec(unconfirmedBalance)?.[0] || ''),
  'the published planned-unconfirmed Bills balance keeps a visible receipt qualifier');
p.rerender("__ctx.advice.defaultView.currentBalancePublication = __ctx.advice.paydayAllocation.currentBalancePublication");

const overspendPage = page();
const overspendHtml = overspendPage.render(fx.served({ groceriesExtra: 200 }));
const overspendPeriod = overspendPage.context.__ctx.advice.payPeriodViews.find(row => row.start === '2026-08-14');
// 212.40 + 96.15 + 200 = 508.55 groceries, above the 450 target.
// Hold = 508.55 + 160 + 120 + 22.99 = 811.54; final = 4050 - 1665 - 811.54.
ok(overspendPeriod.budgetHold === 811.54 && overspendPeriod.balanceAfterDeductions === 1573.46
  && step(overspendHtml, '06').includes(money(644.49)) && step(overspendHtml, '06').includes(money(730))
  && step(overspendHtml, '07').includes(money(1573.46)),
  'observed grocery overrun raises the published household reserve and reduces the final balance by 58.55');
ok(overspendPeriod.fromTodayFunding.remainingHousehold === 167.05
  && /data-budget-spent="groceries"[\s\S]*?Synthetic extra grocer[\s\S]*?200\.00/.test(overspendHtml),
  'the observed overrun stays in transaction evidence; remaining household is 0 groceries + 85.80 fuel + 81.25 dining');

console.log('\n=== navigation ===');
const next = p.context.__ctx.advice.payPeriodViews.find(v => v.timelineRole === 'next');
const nextHtml = p.rerender(`planPayPeriodId = ${JSON.stringify(String(next.id || next.start))}; __ctx.planPayPeriodId = planPayPeriodId`);
ok(/Projected pay period/.test(text(nextHtml)) && nextHtml.includes(`data-calendar-waterfall="${next.id}"`),
  'selecting the next pay period prints its projected waterfall');
ok(/Today's money — current position/.test(text(section(nextHtml, 'today'))), 'Today stays on the current payday when another period is selected');
p.rerender('planPayPeriodId = null; __ctx.planPayPeriodId = null');

console.log('\n=== v3 funding lenses on the active path ===');
const fundingPage = page();
const fundingHtml = fundingPage.render(fx.served());
ok(/data-budget-funding-panel="today"/.test(fundingHtml) && /data-budget-funding-panel="payday"[^>]* hidden/.test(fundingHtml),
  'one proposal is visible at a time; Today and the payday schedule remain separate');
ok(/Keep it separate from today's offer/.test(fundingHtml) && /data-budget-funding-savings hidden/.test(fundingHtml),
  'proposal scopes and complete savings inventory remain available without inventing saved balances');
const fundedCurrent = '__ctx.advice.payPeriodViews.find(row => row.timelineRole === "current")';
for (const update of ["trust: 'unknown'", "contribution: null", "contribution: false", "contribution: '85'", "asOf: '2026-08-19'", "currentThrough: '2026-09-10'", "basis: 'pooled-other-basis'"]) {
  const fp = page(); fp.render(fx.served());
  const out = fp.rerender(`Object.assign(${fundedCurrent}.fromTodayFunding, { ${update} })`);
  const todayPanel = out.split('data-budget-funding-panel="today"')[1].split('data-budget-funding-panel="payday"')[0];
  ok(/data-budget-funding-proposal><span class="budget-v3-unknown">Unavailable/.test(todayPanel),
    `Today refuses unmatched / malformed publication (${update})`);
}
const fundingProof = page(); fundingProof.render(fx.served());
const undatedPage = page(); const undatedHtml = undatedPage.render(fx.served({ withUndatedCost: true }));
for (const key of ['today', 'payday']) {
  const tail = undatedHtml.split(`data-budget-funding-panel="${key}"`)[1];
  const panel = key === 'today' ? tail.split('data-budget-funding-panel="payday"')[0] : tail.split('<aside')[0];
  const cost = panel.split('data-budget-funding-cost="fixture-undated"')[1];
  ok((panel.match(/data-budget-funding-cost="fixture-undated"/g) || []).length === 1, `${key}: undated cost appears once in its published scope`);
  ok(!!cost && /Synthetic undated cost[\s\S]*\$275\.00[\s\S]*Date not established[\s\S]*Contribution unknown/.test(cost),
    `${key}: undated invented $275 cost preserves its known amount and withholds a contribution/date`);
  ok(/budget-funding-track is-unknown/.test(cost), `${key}: unscheduled protection never becomes known-zero contribution geometry`);
}
const exactHtml = fundingProof.rerender(`budgetMonthPlanSpendSchedule = () => ({ status: 'ready', asOf: '2026-08-20', fundingTrust: 'estimated',
  paydays: [{ payday: '2026-08-28', contribution: 95, stillToFund: 305, trust: 'calculated', allocations: [{ id: 'fixture-cost', amount: 95 }] }],
  costs: [{ id: 'fixture-cost', label: 'Independent test cost', date: '2026-09-12', confidence: 'confirmed', baseRequirement: 400 }] })`);
const exactPanel = exactHtml.split('data-budget-funding-panel="payday"')[1];
ok(/data-budget-funding-proposal><span class="budget-v3-est">/.test(exactPanel) && /\$95\.00/.test(exactPanel),
  'future exact-payday contribution carries schedule funding trust, not its calculated live-row stamp');
ok(/style="width:23\.75%"/.test(exactPanel), 'independent geometry: 95 / 400 = 23.75%, with no new money total');
const withheldExact = fundingProof.rerender(`budgetMonthPlanSpendSchedule = () => ({ status: 'ready', asOf: '2026-08-20', fundingTrust: 'unknown',
  paydays: [{ payday: '2026-08-28', contribution: 95, stillToFund: 305, trust: 'calculated', allocations: [{ id: 'fixture-cost', amount: 95 }] }],
  costs: [{ id: 'fixture-cost', label: 'Independent test cost', date: '2026-09-12', confidence: 'confirmed', baseRequirement: 400 }] })`);
ok(!/\$95\.00|\$305\.00/.test(withheldExact.split('data-budget-funding-panel="payday"')[1]),
  'unknown schedule trust withholds future contribution and remaining funding; confirmed cost confidence never repairs projection trust');

for (const change of ["asOf: '2026-08-19'", "asOf: null", "status: 'unavailable'", "fundingTrust: 'unknown'",
  "paydays: [{ payday: '2026-08-19', contribution: 95, stillToFund: 305, allocations: [{ id: 'fixture-cost', amount: 95 }] }]"]) {
  const fp = page(); fp.render(fx.served());
  const out = fp.rerender(`budgetMonthPlanSpendSchedule = () => ({ status: 'ready', asOf: '2026-08-20', fundingTrust: 'estimated',
    paydays: [{ payday: '2026-08-28', contribution: 95, stillToFund: 305, allocations: [{ id: 'fixture-cost', amount: 95 }] }],
    costs: [{ id: 'fixture-cost', label: 'Independent test cost', date: '2026-09-12', confidence: 'confirmed', baseRequirement: 400,
      nextContribution: { payday: '2026-08-28', amount: 95 } }], ${change} })`);
  const panel = out.split('data-budget-funding-panel="payday"')[1];
  ok(!/\$95\.00|\$305\.00/.test(panel) && /Contribution unknown/.test(panel),
    `unmatched payday publication withholds proposal, contribution, next scheduled and protected amounts (${change})`);
  ok(/\$400\.00/.test(panel), 'independently confirmed cost stays known when the funding projection is withheld');
}
for (const value of [null, false, '95', 0]) {
  const fp = page(); fp.render(fx.served());
  const out = fp.rerender(`budgetMonthPlanSpendSchedule = () => ({ status: 'ready', asOf: '2026-08-20', fundingTrust: 'estimated',
    paydays: [{ payday: '2026-08-28', contribution: 95, stillToFund: 305,
      allocations: [{ id: 'fixture-cost', amount: ${JSON.stringify(value)} }] }],
    costs: [{ id: 'fixture-cost', label: 'Independent test cost', date: '2026-09-12', confidence: 'confirmed', baseRequirement: 400 }] })`);
  const cost = out.split('data-budget-funding-panel="payday"')[1].split('data-budget-funding-cost="fixture-cost"')[1];
  ok(value === 0 ? /\$0\.00[\s\S]*proposed this payday/.test(cost) && !/Contribution unknown/.test(cost)
    : /Contribution unknown/.test(cost) && !/\$0\.00[\s\S]*proposed this payday/.test(cost),
  `${JSON.stringify(value)}: explicitly missing/malformed allocation stays unknown; published zero remains known`);
}
const scopePage = page(); scopePage.render(fx.served());
const publishedFunding = vm.runInContext('budgetUpcomingFundingHtml(__ctx)', scopePage.context);
const publishedTodayPanel = publishedFunding.split('data-budget-funding-panel="today"')[1].split('data-budget-funding-panel="payday"')[0];
for (const role of ['past', 'current', 'next']) {
  const period = scopePage.context.__ctx.advice.payPeriodViews.find(row => row.timelineRole === role);
  ok(!!period, `${role}: real Forecast fixture publishes a selectable period`);
  if (!period) continue;
  const out = scopePage.rerender(`planPayPeriodId = ${JSON.stringify(period.id || period.start)}; __ctx.planPayPeriodId = planPayPeriodId`);
  ok(out.includes(publishedTodayPanel), `${role}: period navigation never re-dates Today cash or borrows a selected-period contribution`);
  ok((out.match(/data-from-today-proposal/g) || []).length === 1,
    `${role}: the complete dated current funding evidence remains reachable exactly once`);
}
const retainedLens = scopePage.rerender("budgetFundingLens = 'payday'");
ok(/data-budget-funding-panel="today"[^>]* hidden/.test(retainedLens)
  && /data-budget-funding-panel="payday"[^>]*(?<! hidden)>/.test(retainedLens)
  && /data-budget-funding-tab="payday"[^>]*aria-selected="true"/.test(retainedLens),
  'payday lens remains selected after the active surface rerenders, keeping its evidence trigger reachable');

console.log('\n=== funding history / current / future coverage and settlement ===');
for (const coverage of ['missing', 'partial', 'truncated', 'full', 'posted-only']) {
  for (const settlement of ['unverified', 'paid']) {
    const hp = page(); hp.render(fx.fundingHistorical(coverage, settlement));
    const current = hp.context.__ctx.advice.payPeriodViews.find(row => row.timelineRole === 'current');
    const bills = settlement === 'paid' ? 265 : 370;
    const capacity = settlement === 'paid' ? 501.50 : 396.50;
    const ready = !['truncated', 'posted-only'].includes(coverage);
    ok(current.remainingBills === bills, `${coverage}/${settlement}: actual observation settlement publishes ${bills} remaining bills`);
    ok(ready ? current.fromTodayFunding.operatingBills === bills && current.fromTodayFunding.availableNow === capacity
      : current.fromTodayFunding.status === 'unavailable',
      `${coverage}/${settlement}: independent capacity 1375 - ${bills} - 308.50 - 300 = ${capacity}; incomplete current observations withhold it`);
    for (const role of ['past', 'current', 'next']) {
      const period = hp.context.__ctx.advice.payPeriodViews.find(row => row.timelineRole === role);
      const out = hp.rerender(`planPayPeriodId = ${JSON.stringify(period.id || period.start)}; __ctx.planPayPeriodId = planPayPeriodId`);
      const funding = out.split('data-budget-funding-section')[1];
      ok(/data-budget-funding-proposal><span class="budget-v3-unknown">Unavailable/.test(funding)
        && (ready ? out.includes(money(capacity)) : current.fromTodayFunding.status === 'unavailable'),
        `${coverage}/${settlement}/${role}: policy before confirmation withholds the daily offer while native current-cash evidence retains its scope and trust`);
      ok((out.match(/data-from-today-proposal/g) || []).length === 1,
        `${coverage}/${settlement}/${role}: Today evidence remains available without a duplicate or selected-period substitution`);
    }
  }
}

console.log('\n=== compact savings contribution evidence ===');
{
  const sp = page(); const out = sp.render(fx.served());
  const goals = out.split('data-budget-savings-goals')[1]?.split('data-budget-funding-savings')[0] || '';
  ok(/School trip/.test(goals) && /Winter tires/.test(goals) && /Saved/.test(goals) && /Needed/.test(goals) && /Unavailable/.test(goals),
    'the default savings card retains published names and withholds Saved/Needed before policy confirmation');
  ok(!/Confirmed assigned|Unallocated cash|Currently backed|goalKey/.test(goals),
    'technical account inventory remains behind complete evidence rather than becoming default goal rows');
  const stamped = sp.rerender(`const funding = __ctx.advice.payPeriodViews.find(row => row.timelineRole === 'current').plannedCostFunding;
    funding.items.forEach(row => { row.actualSaved = 9999; row.cumulativeProposed = 9999; row.contribution = 0; });`);
  const stillUnknown = stamped.split('data-budget-savings-goals')[1]?.split('data-budget-funding-savings')[0] || '';
  ok(!/>Funded<|>Still to fund<|9,999/.test(stillUnknown) && /Unavailable/.test(stillUnknown),
    'legacy saved balances and cumulative proposals cannot populate new daily Saved/Needed or This period');
  const inventoryPage = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  ok(/<details class="budget-savings-accounts">\s*<summary>Savings accounts &amp; evidence<\/summary>\s*<div id="savings-inventory"><\/div>\s*<\/details>/.test(inventoryPage),
    'complete inventory is keyboard-accessible through a collapsed native evidence disclosure');
}

console.log('\n=== independent payday undated roster ===');
for (const coverage of ['full', 'truncated', 'posted-only']) {
  const up = page();
  const data = fx.served({ withUndatedCost: true });
  if (coverage === 'truncated') data.liveOverlay.currentPeriodActuals.transactionCoverage = 'truncated';
  if (coverage === 'posted-only') data.liveOverlay.currentPeriodActuals.pendingCoverage = 'unknown';
  const out = up.render(data);
  const schedule = vm.runInContext('budgetMonthPlanSpendSchedule(__ctx, true)', up.context);
  const current = up.context.__ctx.advice.payPeriodViews.find(row => row.timelineRole === 'current');
  ok(coverage === 'full' ? ['ready', 'funding-gap'].includes(schedule.status)
    : schedule.status === 'unavailable' && schedule.paydays.length === 0,
    `${coverage}: incomplete card coverage withholds payday allocations, retaining known costs`);
  if (coverage !== 'full') ok(current.fromTodayFunding.status === 'unavailable', `${coverage}: Today is independently withheld`);
  const panel = out.split('data-budget-funding-panel="payday"')[1]?.split('data-budget-funding-evidence="payday"')[0] || '';
  const undated = panel.split('data-budget-funding-cost="fixture-undated"')[1] || '';
  ok(/Synthetic undated cost/.test(undated) && /\$275\.00/.test(undated),
    `${coverage}: payday retains the independent invented undated price, not Today's roster`);
  ok(/Contribution unknown/.test(undated) && /is-unknown/.test(undated)
    && !/275\.00 proposed|style="width:100%"/.test(undated), `${coverage}: an undated proposal is never an allocation or fulfillment`);
}

console.log('\n=== v3 Month projection publication guards ===');
for (const trust of ['null', 'undefined', "'unknown'", "'unavailable'", "'calculated'", "'estimated'"]) {
  const mp = page(); mp.render(fx.served());
  const out = mp.rerender(`const current = __ctx.advice.payPeriodViews.find(row => row.timelineRole === 'current');
    current.afterHouseholdBudget = 351.20; current.balanceAfterDeductionsTrust = ${trust};
    budgetGranularity = 'month'`);
  const compare = out.split('budget-v3-month-compare')[1]?.split('aria-hidden="true">vs')[0] || '';
  const known = ['null', "'calculated'", "'estimated'"].includes(trust);
  ok(known ? /\$351\.20/.test(compare) : /Unavailable/.test(compare) && !/351\.20|\$0\.00/.test(compare),
    `${trust}: comparison honors the incumbent explicit-null calculated marker without repairing missing or untrusted fields`);
  ok(trust === "'estimated'" ? /budget-v3-est/.test(compare) : !/budget-v3-est/.test(compare), `${trust}: comparison retains its estimate qualifier`);
}
{
  const mp = page(); mp.render(fx.served());
  const out = mp.rerender(`const current = __ctx.advice.payPeriodViews.find(row => row.timelineRole === 'current');
    delete current.balanceAfterDeductionsTrust; budgetGranularity = 'month'`);
  ok(/Unavailable/.test(out.split('budget-v3-month-compare')[1]?.split('aria-hidden="true">vs')[0] || ''),
    'absent comparison trust remains unavailable');
}
for (const monthKey of ['2026-08', '2026-09', '2026-10']) {
  const mp = page(); mp.render(fx.served());
  const month = vm.runInContext(`budgetTrajectoryFor(__ctx).months.find(row => row.month === '${monthKey}')`, mp.context);
  ok(!!month, `${monthKey}: real Forecast fixture publishes the selected Month`);
  if (!month) continue;
  const out = mp.rerender(`budgetGranularity = 'month'; budgetSelectedMonth = '${monthKey}'`);
  ok(out.includes(`data-budget-month-view="${monthKey}"`), `${monthKey}: active Month is the selected publication`);
  const figure = /budget-v3-month-hero[\s\S]*?<\/p>/.exec(out)?.[0] || '';
  ok(month.stage3.dateOrderResult.status === 'unavailable' ? /Unavailable/.test(figure)
    : figure.includes(money(Math.abs(month.stage3.dateOrderResult.amount)))
      && (month.stage3.dateOrderResult.amount < 0 ? /data-budget-month-verdict="deficit"/.test(out) : true),
    `${monthKey}: hero retains exact published date-order result and its sign`);
}
for (const status of ['unavailable', 'unknown', 'untrusted']) {
  const mp = page(); mp.render(fx.served());
  const out = mp.rerender(`globalThis.__monthFixture = JSON.parse(JSON.stringify(budgetTrajectoryFor(__ctx)));
    __monthFixture.months[0].stage3.dateOrderResult = { amount: 351.20, status: '${status}', reason: 'Independent withheld fixture' };
    budgetTrajectoryFor = () => __monthFixture; budgetGranularity = 'month'; budgetSelectedMonth = __monthFixture.months[0].month`);
  const figure = /budget-v3-month-hero[\s\S]*?<\/p>/.exec(out)?.[0] || '';
  ok(/Unavailable/.test(figure) && !/351\.20|\$0\.00/.test(figure), `${status}: Month never repairs an untrusted date-order result`);
  ok(/data-budget-month-ladder="unavailable"/.test(out), `${status}: third rung withholds geometry and preserves unavailable evidence`);
}

console.log('\n=== month view and month-to-pay-period drilldown ===');
const monthHtml = p.rerender("budgetGranularity = 'month'");
ok(/data-budget-surface="month"/.test(monthHtml), 'the Month switch shows the month view');
const monthEvidence = vm.runInContext('budgetMonthFundingPressureHtml(budgetTrajectoryFor(__ctx).months.find(month => month.month === budgetSelectedMonth), budgetMonthPlanSpendSchedule(__ctx))', p.context);
ok(monthHtml.includes(monthEvidence), 'the Month presentation preserves complete incumbent cost funding evidence');
ok((monthHtml.match(/data-budget-month-picker/g) || []).length === 1,
  'the active Month path has exactly one real picker');
ok(/See the pay periods in August 2026/.test(text(monthHtml)), 'the month offers its pay-period drilldown');
const drillHtml = p.rerender("budgetPayPeriodAnchorMonth = budgetSelectedMonth; budgetGranularity = 'pay-period'");
ok(/data-budget-surface="drilldown"/.test(drillHtml) && /data-budget-drilldown="2026-08"/.test(drillHtml),
  'entering Pay period from Month keeps the month-anchored drilldown');
ok(/data-budget-drilldown-exit/.test(drillHtml), 'the drilldown has a way back to the current pay period');
const back = p.rerender('budgetPayPeriodAnchorMonth = null; budgetDrilldownPayPeriod = null');
ok(/data-budget-surface="pay-period"/.test(back), 'leaving the drilldown returns to the current pay period');

console.log('\n=== withheld savings proposals ===');
const withheldPage = page();
const withheld = withheldPage.render(fx.served({ withheldSavings: true }));
ok(!/data-budget-cash-withheld|Open info for evidence/.test(withheld),
  'owner-marked duplicate funding callout is absent from the overview');
ok(/data-budget-cash-how[\s\S]*data-budget-today-evidence[\s\S]*budget-today-evidence-body/.test(withheld),
  'the existing Info control still reaches the unavailable funding evidence');
const inventory = text(withheldPage.context.document.getElementById('savings-inventory').innerHTML);
// Configured accounts, unknown cash and unknown starting allocations are
// three different facts; each pool must keep the one that applies to it.
const poolA = inventory.slice(inventory.indexOf('Synthetic reserve A'), inventory.indexOf('Synthetic reserve B'));
const poolB = inventory.slice(inventory.indexOf('Synthetic reserve B'));
ok(poolA.length > 0 && poolB.length > 0, 'both configured savings accounts are listed by name', inventory.slice(0, 300));
ok(/^Synthetic reserve A Assignments unknown/.test(poolA) && /Observed pool cash \$0\.00 verified/.test(poolA),
  'pool A: observed cash is known and shown as observed; its assignments are unknown', poolA.slice(0, 300));
ok(/^Synthetic reserve B Cash unknown/.test(poolB) && /Observed pool cash Unknown/.test(poolB),
  'pool B: its cash is unknown, not $0', poolB.slice(0, 300));
ok([poolA, poolB].every(pool => /Confirmed assigned Unknown/.test(pool) && /Unallocated cash Unknown/.test(pool)
    && /Starting goal assignments have not been supplied/.test(pool)),
  'both pools: starting allocations are unknown, never $0');
ok(!/not set up/i.test(inventory), 'configured accounts are not called "not set up"');
const reason = 'Additional savings proposals are withheld until the funding plan accounts for existing assignments and the cash used to pay each cost.';
ok(text(withheld).includes(reason), "Forecast's withheld reason is shown");
ok(!/Proposed to set aside now/.test(withheld) && !/data-from-today-cost/.test(withheld),
  'no proposed amounts are printed while proposals are withheld');
ok(step(withheld, '07').includes(money(EXPECT.final)), 'the waterfall itself is unchanged by withheld savings');

console.log('\n=== current plan unavailable ===');
const downHtml = page().render(fx.served({ unavailablePlan: true }));
ok(/data-budget-surface="unavailable"/.test(downHtml) && /Current plan unavailable/.test(text(downHtml)),
  'an untrusted refresh shows the unavailable surface');
// The Aug 13 opening, independently: 15 bills account + 604.49 spending account.
ok(text(downHtml).includes(`Last trusted opening ${money(15 + 604.49)}`) && /As at August 13/.test(text(downHtml)),
  'the last trusted opening is the dated Aug 13 balance, labelled as dated', text(downHtml).slice(0, 400));
ok(!downHtml.includes(money(EXPECT.final)) && !/data-calendar-waterfall="/.test(downHtml),
  'no pay-period figures are printed when the plan is unavailable');
ok(!/data-budget-period-result/.test(downHtml), 'the overview is withheld with the unavailable operating plan');

console.log('\n=== known deficit is not unknown ===');
{
  // Independent fixture arithmetic, not a rerun of Forecast's leftover helper.
  const DEFICIT = {
    income: 2600 + 1450,
    bills: 1400 + 120 + 60 + 85 + 5000,
    household: 450 + 160 + 120 + 22.99,
  };
  DEFICIT.afterBills = DEFICIT.income - DEFICIT.bills;
  DEFICIT.final = Math.round((DEFICIT.afterBills - DEFICIT.household) * 100) / 100;
  const signed = n => (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-CA', {
    minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const deficitPage = page();
  const deficitHtml = deficitPage.render(fx.served({ deficitPeriod: true }));
  const published = deficitPage.context.__ctx.advice.payPeriodViews.find(row => row.start === '2026-08-14');
  ok(published && published.afterBills === DEFICIT.afterBills
    && published.afterHouseholdBudget === DEFICIT.final
    && published.balanceAfterDeductions === DEFICIT.final
    && published.balanceAfterDeductionsTrust === 'estimated',
    `Forecast publishes independently derived − after-bills ${DEFICIT.afterBills} and final ${DEFICIT.final}, estimated`,
    published && `${published.afterBills} / ${published.afterHouseholdBudget} / ${published.balanceAfterDeductionsTrust}`);
  const summaryHtml = id => deficitHtml.split(`data-operating-question="${id}"`)[1]?.split('</summary>')[0] || '';
  const heroText = text(/data-budget-period-result[\s\S]*?<\/div>/.exec(deficitHtml)?.[0] || '');
  ok(heroText.includes(signed(DEFICIT.final)) && /estimated/.test(heroText),
    'the hero keeps the published negative final and its estimate qualifier', heroText);
  ok(/data-budget-bar-state="known"/.test(summaryHtml('06')) && step(deficitHtml, '06').includes('$444.49')
    && step(deficitHtml, '06').includes('$730.00'), 'Household actual progress remains 444.49 / 730 independently of the known negative financial balance');
  ok(/budget-waterfall-track is-deficit/.test(summaryHtml('07')) && !/is-unknown/.test(summaryHtml('07'))
    && step(deficitHtml, '07').includes(signed(DEFICIT.final)) && /≈ estimated/.test(step(deficitHtml, '07')),
    'the final negative amount uses the deficit track and keeps its published dollars and estimate');
  ok(/budget-waterfall-track is-deficit/.test(summaryHtml('05')) && step(deficitHtml, '05').includes(signed(DEFICIT.afterBills)),
    'the negative after-bills row keeps its published deficit and is not hatched unknown');
  ok(!/style="left:|budget-waterfall-track|budget-progress-track/.test(summaryHtml('savings'))
    && /Savings[\s\S]*?Unavailable/.test(text(deficitHtml)),
    'unavailable savings stock has no deduction geometry and is never invented zero');
}

console.log('\n=== known zero income is not unknown ===');
{
  // Independent fixture arithmetic: scheduled amounts stay 0; bills and
  // household targets are the canonical invented figures.
  const ZERO = {
    income: 0,
    bills: 1400 + 120 + 60 + 85,
    household: 450 + 160 + 120,
  };
  ZERO.afterBills = ZERO.income - ZERO.bills;
  ZERO.final = ZERO.afterBills - ZERO.household;
  const signed = n => (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-CA', {
    minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const zeroPage = page();
  const zeroHtml = zeroPage.render(fx.served({ zeroIncomeWithoutSpend: true }));
  const published = zeroPage.context.__ctx.advice.payPeriodViews.find(row => row.start === '2026-08-14');
  ok(published && published.available === ZERO.income
    && published.incomeTrust === 'calculated'
    && published.afterBills === ZERO.afterBills
    && published.budgetHold === ZERO.household
    && published.afterHouseholdBudget === ZERO.final
    && published.balanceAfterDeductions === ZERO.final
    && published.balanceAfterDeductionsTrust === 'estimated',
    `Forecast publishes independently derived $0 income, after-bills ${ZERO.afterBills} and final ${ZERO.final}, estimated`,
    published && `${published.available} / ${published.afterBills} / ${published.afterHouseholdBudget} / ${published.incomeTrust}`);
  const summaryHtml = id => zeroHtml.split(`data-operating-question="${id}"`)[1]?.split('</summary>')[0] || '';
  const heroText = text(/data-budget-period-result[\s\S]*?<\/div>/.exec(zeroHtml)?.[0] || '');
  ok(heroText.includes(signed(ZERO.final)) && /estimated/.test(heroText),
    'the hero keeps the published negative final and its estimate qualifier', heroText);
  ok(/budget-waterfall-track is-unknown/.test(summaryHtml('02')) && !/style="left:/.test(summaryHtml('02'))
    && /data-budget-ratio-plan>[\s\S]*?\$0\.00/.test(summaryHtml('02')), 'known zero original income plan survives while unobserved actual stays unavailable');
  ok(/budget-waterfall-track is-unknown/.test(summaryHtml('04')) && !/style="left:/.test(summaryHtml('04'))
    && step(zeroHtml, '04').includes(money(ZERO.bills)), 'original bill plan survives while absent actual evidence has no invented paid bar');
  ok(/budget-waterfall-track is-deficit/.test(summaryHtml('05')) && !/is-unknown/.test(summaryHtml('05'))
    && !/style="left:/.test(summaryHtml('05')) && step(zeroHtml, '05').includes(signed(ZERO.afterBills)),
    'the negative after-bills row keeps its published deficit and is not hatched unknown');
  ok(/budget-waterfall-track is-unknown/.test(summaryHtml('06')) && !/style="left:/.test(summaryHtml('06'))
    && step(zeroHtml, '06').includes(money(ZERO.household)), 'original household plan survives while no observations cannot become zero actual spending');
  ok(/budget-waterfall-track is-deficit/.test(summaryHtml('07')) && !/is-unknown/.test(summaryHtml('07'))
    && !/style="left:/.test(summaryHtml('07'))
    && step(zeroHtml, '07').includes(signed(ZERO.final)) && /≈ estimated/.test(step(zeroHtml, '07')),
    'the final negative amount uses the deficit track and keeps its published dollars and estimate');
  ok(!/style="left:|budget-waterfall-track|budget-progress-track/.test(summaryHtml('savings'))
    && /Savings[\s\S]*?Unavailable/.test(text(zeroHtml)),
    'unavailable savings stock has no deduction geometry and is never invented zero');
}

console.log('\n=== outgoing e-transfer review section (browse + unavailable paths) ===');
{
  const etSection = out => out.split('data-budget-browse="e-transfers"')[1]?.split('</section>')[0] || '';
  // Real end to end: invented provider row -> provider-observe boolean ->
  // Forecast publication -> the active Budget browse surface.
  const etPage = page();
  const etHtml = etPage.render(fx.served({ etransfer: true }));
  const etSec = etSection(etHtml);
  ok(/data-etransfer-state="available-complete"/.test(etHtml) && etSec.includes('Outgoing e-transfer')
    && etSec.includes('$75.00') && etSec.includes('Weekly spending account') && etSec.includes('Aug 19'),
    'current period: the flagged outgoing e-transfer renders with generic label, date, amount and canonical account display label only');
  ok((etSec.match(/Purpose not yet confirmed/g) || []).length === 1
    && etSec.includes('<details class="budget-etransfers-review">') && !etSec.includes('chequing-b'),
    'transfer review is a native closed disclosure with one purpose note and a household account label');
  ok(!etHtml.includes('SEND E-TFR') && !etSec.includes('Synthetic recipient'),
    'no raw descriptor or payee text reaches the rendered surface');
  ok(etPage.context.__ctx.advice.currentPeriodAction.outgoingETransfers.count === 1,
    'Forecast published exactly the one flagged row for the fixture packet');

  // Navigation: the section belongs to the current pay period only.
  const views = etPage.context.__ctx.advice.payPeriodViews;
  const nextView = views.find(row => row.timelineRole === 'next');
  const pastView = views.find(row => row.timelineRole === 'past');
  ok(nextView && !etSection(etPage.rerender(`__ctx.planPayPeriodId = ${JSON.stringify(nextView.id)}`)),
    'future period selection: no e-transfer section (the current list is not shown under a future period)');
  if (pastView) {
    ok(!etSection(etPage.rerender(`__ctx.planPayPeriodId = ${JSON.stringify(pastView.id)}`)),
      'past period selection: no e-transfer section');
  }
  ok(etSection(etPage.rerender('__ctx.planPayPeriodId = null')).includes('Outgoing e-transfer'),
    'returning to the current period restores the section');
  ok(!etSection(etPage.rerender("budgetGranularity = 'month'")),
    'month view: no e-transfer section (browse sections are pay-period only)');
  etPage.rerender("budgetGranularity = 'pay-period'");

  // State notices via the same render path, mutating only the publication.
  const statePage = page(); statePage.render(fx.served({ etransfer: true }));
  const setPub = pub => statePage.rerender(
    `__ctx.advice.currentPeriodAction.outgoingETransfers = ${JSON.stringify(pub)}`);
  const item = { id: 'tx-9', date: '2026-08-19', amount: 75, pending: true, account: 'chequing-b' };
  const cov = { status: 'current', reason: null, observationAsOf: '2026-08-20', coverageStart: '2026-08-14', coverageThrough: '2026-08-20', pendingStatus: 'unknown' };
  let sec = etSection(setPub({ status: 'available-posted-only', coverage: cov, count: 1, items: [item] }));
  ok(sec.includes('Pending coverage is incomplete') && sec.includes('$75.00') && sec.includes('Pending'),
    'posted-only: observed items shown with the incomplete-pending notice and pending flag');
  sec = etSection(setPub({ status: 'available-incomplete', coverage: { ...cov, reason: 'Posted transaction coverage is truncated.' }, count: 1, items: [item] }));
  ok(sec.includes('observed subset') && sec.includes('may be missing items') && sec.includes('$75.00'),
    'incomplete with collected items: items are labelled an observed subset, never a complete queue');
  sec = etSection(setPub({ status: 'available-incomplete', coverage: cov, count: null, items: null }));
  ok(sec.includes('may be missing items') && !sec.includes('$75.00') && !/data-etransfer-item/.test(sec),
    'incomplete with nothing collected: notice only, no list, no amount, no zero');
  sec = etSection(setPub({ status: 'available-complete', coverage: { ...cov, pendingStatus: 'complete' }, count: 0, items: [] }));
  ok(sec.includes('No unresolved outgoing e-transfers from household cash accounts are listed for review this period.'),
    'available-complete with zero items is the only rendered all-clear, scoped to the review list');
  sec = etSection(setPub({ status: 'unavailable-stale', coverage: { ...cov, status: 'stale' }, count: null, items: null }));
  ok(sec.includes("can't be confirmed") && !/data-etransfer-item/.test(sec) && !sec.includes('$'),
    'stale: no list, no count, no money figure — a stale-evidence notice only');
  sec = etSection(setPub({ status: 'unavailable-missing', coverage: null, count: null, items: null }));
  ok(sec.includes("can't be confirmed") && !/data-etransfer-item/.test(sec) && !sec.includes('$'),
    'missing: no list, no count, no money figure — an unavailable notice only');

  // Repair (Atlas, P1 4253142082, 2026-10-12): the complete-state copy
  // describes the filtered review list, not all observed outgoing
  // transfers. Excluded-only evidence — complete coverage whose one
  // observed outgoing transfer was sent from a revolving-credit account
  // (the §ET ex-revolving exclusion) — publishes an empty list; the copy
  // must scope the all-clear to the review list and must never claim no
  // outgoing e-transfers were observed.
  const etExcludedRow = { id: 'et-excluded-revolving', date: '2026-08-19', amount: 120,
    pending: false, categoryLabel: 'Transfer', accountRole: 'revolving-credit',
    atlasAccountId: 'travelvisa', outgoingETransferIdentity: true,
    displayedPayee: 'Synthetic recipient' };
  const exclData = fx.served({});
  exclData.liveOverlay.currentPeriodActuals.transactions.push({ ...etExcludedRow });
  const exclPage = page();
  const exclSec = etSection(exclPage.render(exclData));
  ok(exclPage.context.__ctx.advice.currentPeriodAction.outgoingETransfers.count === 0
    && /data-etransfer-state="available-complete"/.test(exclSec)
    && !/data-etransfer-item/.test(exclSec),
    'excluded-only: complete evidence with only an excluded transfer publishes an empty review list');
  ok(exclSec.includes('No unresolved outgoing e-transfers from household cash accounts are listed for review this period.')
    && !exclSec.includes('No outgoing e-transfers were observed'),
    'excluded-only: the all-clear is scoped to the review list and never claims no transfers were observed');

  // Mixed eligible + excluded: the count names eligible review items
  // only, in the same scoped wording; the excluded transfer is not
  // listed and does not inflate the count.
  const mixedData = fx.served({ etransfer: true });
  mixedData.liveOverlay.currentPeriodActuals.transactions.push({ ...etExcludedRow });
  const mixedPage = page();
  const mixedSec = etSection(mixedPage.render(mixedData));
  ok(mixedPage.context.__ctx.advice.currentPeriodAction.outgoingETransfers.count === 1
    && mixedSec.includes('1 unresolved outgoing e-transfer from household cash accounts is listed for review this period.')
    && mixedSec.includes('$75.00') && !mixedSec.includes('$120.00'),
    'mixed eligible/excluded: the count is scoped to the one eligible review item; the excluded transfer is not listed');

  // Plan-unavailable path: BudgetSurface skips browseHtml there, so the
  // section must arrive through the unavailableHtml contribution as a
  // notice only — never resurrecting items.
  const unPage = page(); unPage.render(fx.served({ etransfer: true }));
  const unHtml = unPage.rerender('__ctx.advice.operatingPlanUnavailable = true');
  const unSec = etSection(unHtml);
  ok(/data-budget-surface="unavailable"/.test(unHtml) && unSec
    && /data-etransfer-state="unavailable-/.test(unHtml) && unSec.includes("can't be confirmed")
    && !/data-etransfer-item/.test(unSec),
    'plan unavailable: browse is skipped, yet the e-transfer section still renders as an unavailable notice with no items');
  const failedHtml = page().render(fx.served({ unavailablePlan: true }));
  ok(etSection(failedHtml).includes("can't be confirmed") && !/data-etransfer-item/.test(etSection(failedHtml)),
    'failed-overlay served packet: the unavailable notice renders and no stale rows are resurrected');

  // Repair (Atlas, 2026-10-12): the unavailable contribution carries the
  // same current-period gate as the browse renderer — under a past or
  // future selection the current-period notice must not render either.
  const gatePage = page(); gatePage.render(fx.served({ etransfer: true }));
  const gateViews = gatePage.context.__ctx.advice.payPeriodViews;
  const gateNext = gateViews.find(row => row.timelineRole === 'next');
  const gatePast = gateViews.find(row => row.timelineRole === 'past');
  ok(gateNext && !etSection(gatePage.rerender(
    `__ctx.advice.operatingPlanUnavailable = true; __ctx.planPayPeriodId = ${JSON.stringify(gateNext.id)}`)),
    'plan unavailable + future period selected: no e-transfer notice under the future period');
  if (gatePast) {
    ok(!etSection(gatePage.rerender(
      `__ctx.advice.operatingPlanUnavailable = true; __ctx.planPayPeriodId = ${JSON.stringify(gatePast.id)}`)),
      'plan unavailable + past period selected: no e-transfer notice under the past period');
  }
  ok(etSection(gatePage.rerender(
    '__ctx.advice.operatingPlanUnavailable = true; __ctx.planPayPeriodId = null')).includes("can't be confirmed"),
    'plan unavailable + current period selected: the notice renders again');

  // Repair (Atlas BLOCK 5494607988, 2026-10-12): the unavailable card is
  // rendered under either granularity, so the period gate alone leaks the
  // notice into the month view when a current-period selection is
  // retained. The notice belongs to the current pay-period view only.
  const monthGateHtml = gatePage.rerender(
    "__ctx.advice.operatingPlanUnavailable = true; __ctx.planPayPeriodId = null; budgetGranularity = 'month'");
  ok(/data-budget-surface="unavailable"/.test(monthGateHtml) && !etSection(monthGateHtml),
    'plan unavailable + month view + retained current period: no e-transfer notice (the unavailable card itself still renders)');
  ok(etSection(gatePage.rerender("budgetGranularity = 'pay-period'")).includes("can't be confirmed"),
    'plan unavailable + back in the pay-period view: the notice renders again');
}

console.log('\n=== the layout module stays a layout module ===');
{
  const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const surfaceAt = index.indexOf('<script src="/budget-surface.js"></script>');
  ok(surfaceAt > 0 && surfaceAt < index.indexOf('<script src="/plan.js"></script>')
      && /href="\/budget-surface\.css"/.test(index),
    'index.html loads the surface stylesheet and script before plan.js');
  const src = fs.readFileSync(path.join(ROOT, 'public/budget-surface.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/\bForecast\b/.test(src), 'budget-surface.js does not reach Forecast');
  ok(!/\.reduce\(|[^=!<>]=\s*[^=>]*[-+*/]\s*\d|\bamount\b|\bbalance\b|\btrust\b/.test(src),
    'budget-surface.js reads no money or trust field and does no arithmetic');
}

assert.ok(true);
if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
