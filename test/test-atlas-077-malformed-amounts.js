'use strict';
/* ATLAS-077 (#726) — Supplementary VM renderer and Assistant-packet
 * regression suite for malformed scheduled bill, commitment, and obligation
 * amounts (companion to the real-browser Playwright acceptance suite in
 * `test/browser-malformed-scheduled-amounts-acceptance.js`).
 *
 * Exercises the merged PR #637 (`a6cdd394`) `Forecast.scheduledAmountState`
 * fail-closed contract in Node/VM and packet helpers:
 *   1. Active Budget surface (`public/budget-surface.js` + `public/plan.js`)
 *      in both Pay Period and Month (Road Ahead / `baselineTrajectory`) views.
 *   2. Credit page (`public/credit.js` consuming `Forecast.creditAccounts`).
 *   3. Bills page (`public/bills.js` consuming `Forecast.householdBills`).
 *   4. Plan Spend page (`public/plan-spend.js` consuming `Forecast.majorPlans`
 *      and `Forecast.planSpendPaydayFunding`).
 *   5. Assistant / Talk context packet (`scripts/assistant-packet.js`).
 *   6. Transition & recovery lifecycle: valid numeric schedule -> malformed
 *      scheduled amounts (`null`, `NaN`, `"1,900"`, `""`, `"$85"`, `Infinity`,
 *      `true`, `[85]`) -> statement-minimum replacement (Ruling C) -> valid
 *      numeric `0` -> restored original amounts.
 *
 * Synthetic fixtures only (`test/fixtures/budget-surface-data.js`).
 * Independent expectations are computed by hand from the synthetic fixture
 * inputs rather than reading Forecast outputs back as the specification.
 *
 * `node test/test-atlas-077-malformed-amounts.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast.js');
const fx = require('./fixtures/budget-surface-data.js');
const Assistant = require('../scripts/assistant-packet.js');
const { sourceText } = require('./test-source-text.js');

const ROOT = path.join(__dirname, '..');
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const strip = html => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

let failures = 0;
function ok(cond, label, detail = '') {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ' — ' + detail : ''}`);
}

// Independent hand arithmetic from `test/fixtures/budget-surface-data.js`:
//   Pay period: 2026-08-14 .. 2026-08-27, as-of 2026-08-20 (91-day window)
//   Income:     2,600 (payroll Aug 14) + 1,450 (partner Aug 25) = 4,050.00
//   Bills in period: 1,400 (mortgage Aug 15, paid) + 120 (hydro Aug 18) + 85 (internet Aug 24) + 60 (card-minimum Aug 22) = 1,665.00
//   91-day sim.totals.bills (Aug 20 .. Nov 18, plus carried unresolved Aug 18 hydro):
//     3 months of mortgage (1,400 * 3 = 4,200) + 4 occurrences of hydro (120 * 4 = 480)
//     + 3 occurrences of internet (85 * 3 = 255) = 4,935.00
//   Zero-internet bills total in period: 1,400 + 120 + 0 + 60 = 1,580.00
//   Household budget: 450 (groceries) + 160 (fuel) + 120 (restaurants) + 22.99 (unassigned actual) = 752.99
//   Observed cash (Aug 20): chequing-a 1,215.00, chequing-b 160.00 -> available 1,375.00
//   Canonical dated chequing opening (Aug 13): 15.00 + 604.49 = 619.49
//   Balance After Deductions (valid): 4,050.00 - 1,665.00 - 752.99 = 1,632.01
//   Balance After Deductions (internet = 0): 4,050.00 - 1,580.00 - 752.99 = 1,717.01
//   Credit card (travelvisa): balance 2,000.00, limit 5,000.00, available 3,000.00, rate 19.99%, next min 60.00 on 2026-08-22
const EXPECT = Object.freeze({
  income: 2600 + 1450,
  billsTotal: 1400 + 120 + 85 + 60,
  billsZeroInternet: 1400 + 120 + 0 + 60,
  simBillsTotal91d: (1400 * 3) + (120 * 4) + (85 * 3),
  householdHold: 450 + 160 + 120 + 22.99,
  canonicalChequing: 15 + 604.49,
  observedBillsCash: 1215,
  observedAvailableCash: 1215 + 160,
  finalValid: Math.round(((2600 + 1450) - (1400 + 120 + 85 + 60) - (450 + 160 + 120 + 22.99)) * 100) / 100,
  finalZeroInternet: Math.round(((2600 + 1450) - (1400 + 120 + 0 + 60) - (450 + 160 + 120 + 22.99)) * 100) / 100,
  cardBalance: 2000,
  cardLimit: 5000,
  cardAvailable: 5000 - 2000,
  cardMin: 60,
  cardDueDate: '2026-08-22',
  schoolTripNeed: 400,
  winterTiresNeed: 900,
});
assert.equal(EXPECT.finalValid, 1632.01);
assert.equal(EXPECT.finalZeroInternet, 1717.01);
assert.equal(EXPECT.simBillsTotal91d, 4935);

function stubEl() {
  return {
    innerHTML: '', textContent: '', hidden: false, value: '',
    style: { setProperty() {}, getPropertyValue() { return ''; } }, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, hasAttribute() { return false; },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild() {}, insertAdjacentHTML() {}, closest() { return null; }, children: [],
  };
}

function createBudgetPage() {
  const els = new Map();
  const context = vm.createContext({ escapeHtml: require('./app-escape-html'),
    Forecast: F, console, addEventListener() {}, setTimeout, clearTimeout,
    document: {
      addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
      getElementById(id) { if (!els.has(id)) els.set(id, stubEl()); return els.get(id); },
      documentElement: { dataset: {}, style: {} }, createElement: stubEl, createElementNS: stubEl, body: stubEl(),
    },
    window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
    localStorage: { getItem() { return null; }, setItem() {} },
    location: { pathname: '/', search: '' },
  });
  context.window = Object.assign(context, { matchMedia() { return { matches: false, addEventListener() {} }; } });
  vm.runInContext(read('public/app.js'), context);
  vm.runInContext('App.boot = () => {}; App.once = () => {}; App.register = () => {};', context);
  for (const f of ['forecast-chequing.js', 'balance-history.js', 'bill-detail.js', 'savings-inventory.js',
    'budget-surface.js', 'plan.js']) {
    vm.runInContext(read(path.join('public', f)), context);
  }
  vm.runInContext('forecastChart = () => {}; renderCalendar = () => {};', context);
  vm.runInContext('const __active = budgetSurfaceHtml; budgetSurfaceHtml = function (ctx) { globalThis.__ctx = ctx; return __active(ctx); };', context);
  return {
    context,
    render(served) {
      context.served = served;
      vm.runInContext("Object.defineProperty(App, 'data', { get: () => served, configurable: true });", context);
      vm.runInContext('Object.assign(state, served.plan.defaults, { debts: served.debts }); renderPlan(served, null, null);', context);
      return els.get('operating-surface-body').innerHTML;
    },
    monthViewHtml() {
      return vm.runInContext("budgetGranularity = 'month'; const h = budgetMonthViewHtml(__ctx); budgetGranularity = 'pay-period'; h", context);
    },
  };
}

function loadAppPage(script) {
  const appSrc = read('public/app.js');
  const grab = re => { const m = re.exec(appSrc); if (!m) throw new Error('missing ' + re); return m[0]; };
  const helpers = [
    grab(/^const money = .*$/m), grab(/^const money2 = .*$/m), grab(/^const escapeHtml = .*$/m), grab(/^const pct = .*$/m),
    grab(/^const fmtDate = .*$/m), grab(/^const fmtDateLong = .*$/m), grab(/^const fmtDateFull = .*$/m),
  ].join('\n');
  const elements = {};
  const ctx = {
    Forecast: F, console, elements,
    App: { hooks: [], bootOpts: null, register(fn) { this.hooks.push(fn); }, boot(opts) { this.bootOpts = opts || {}; } },
  };
  vm.runInNewContext(
    `${helpers}\nconst $ = id => elements[id] || (elements[id] = { innerHTML: '', textContent: '' });\n${read(script)}`,
    ctx, { filename: script }
  );
  return {
    ctx,
    render(data, periods) {
      for (const k of Object.keys(elements)) delete elements[k];
      for (const fn of ctx.App.hooks) fn(data, periods || null, null);
      return elements;
    },
  };
}

function heroText(html) {
  const m = /data-budget-period-result(?:=|>|\s)[\s\S]*?<\/div>/.exec(html);
  return m ? strip(m[0]) : '';
}

const budgetPage = createBudgetPage();
const creditPage = loadAppPage('public/credit.js');
const billsPage = loadAppPage('public/bills.js');
const planSpendPage = loadAppPage('public/plan-spend.js');

const MALFORMED_SHAPES = [
  ['null', null],
  ['NaN', NaN],
  ['"1,900"', '1,900'],
  ['""', ''],
  ['"$85"', '$85'],
  ['Infinity', Infinity],
  ['true', true],
  ['[85]', [85]],
];

console.log('=== 1. Baseline valid household state across all consumer surfaces ===');
{
  const valid = fx.served();
  const html = budgetPage.render(valid);
  const adv = budgetPage.context.__ctx.advice;
  const cur = adv.payPeriodViews.find(r => r.timelineRole === 'current');
  const state = F.scheduledAmountState(valid.plan, valid.meta.asOf, adv.knowledge.end, {});

  ok(state.status === 'ready' && state.unknowns.length === 0 && adv.scheduledAmounts === undefined,
    'baseline valid schedule: scheduledAmountState is ready with zero unknowns');
  ok(cur.periodBillLoad === EXPECT.billsTotal
    && cur.balanceAfterDeductions === EXPECT.finalValid
    && cur.currentBalance === EXPECT.canonicalChequing
    && typeof adv.weekly === 'number' && adv.weekly > 0,
    'baseline valid schedule: Budget period bill load (1,665), Balance After Deductions (1,632.01), and weekly cap publish',
    `load=${cur.periodBillLoad} bad=${cur.balanceAfterDeductions} weekly=${adv.weekly}`);
  ok(heroText(html).includes('$1,632.01') && !/Unavailable/.test(heroText(html)),
    'baseline valid schedule: active Budget hero prints $1,632.01');

  const creditEls = creditPage.render(valid);
  const cardText = strip(creditEls['credit-cards'].innerHTML);
  ok(cardText.includes('$2,000.00') && cardText.includes('$5,000.00')
    && cardText.includes('$3,000.00') && cardText.includes('$60.00')
    && cardText.includes('August 22, 2026'),
    'baseline valid schedule: Credit page prints balance $2,000, limit $5,000, available $3,000, and next minimum $60 on Aug 22');

  const billsEls = billsPage.render(valid);
  const billsText = strip(billsEls['bills-list'].innerHTML);
  ok(billsText.includes('Internet CONFIRMED Amount $85.00')
    && billsText.includes('Mortgage CONFIRMED Amount $1,400.00')
    && billsText.includes('Hydro ESTIMATED Amount ≈ $120.00'),
    'baseline valid schedule: Bills page prints Internet $85, Mortgage $1,400, and Hydro $120');

  const spendEls = planSpendPage.render(valid);
  const spendText = strip(spendEls['plan-spend-list'].innerHTML);
  ok(spendText.includes('School trip $400.00') && spendText.includes('Winter tires $900.00')
    && spendText.includes('FEASIBLE IN CURRENT PLAN'),
    'baseline valid schedule: Plan Spend page prints both commitments ($400, $900) as feasible');
}

console.log('\n=== 2. Malformed scheduled BILL amounts fail closed without fabricating $0 ===');
for (const [label, badAmount] of MALFORMED_SHAPES) {
  const data = fx.served();
  data.plan.bills.find(b => b.id === 'internet').amount = badAmount;
  const html = budgetPage.render(data);
  const adv = budgetPage.context.__ctx.advice;
  const cur = adv.payPeriodViews.find(r => r.timelineRole === 'current');

  ok(adv.scheduledAmounts && adv.scheduledAmounts.status === 'unavailable'
    && adv.scheduledAmounts.unknowns.some(u => u.carrier === 'bill' && u.id === 'internet' && u.date === '2026-08-24'),
    `malformed bill (${label}): recommend carries unavailable scheduledAmounts naming internet on 2026-08-24`);
  ok(adv.weekly === null && adv.holds === null && adv.binding === null
    && adv.sim.totals.bills === null && adv.sim.ending === null
    && adv.knowledge.ending === null && adv.knowledge.freeCash === null,
    `malformed bill (${label}): weekly cap, holds, sim.totals.bills, and walk endings are withheld (null)`);
  ok(cur.periodBillLoad === null && cur.periodBillLoadTrust === 'unavailable'
    && cur.balanceAfterDeductions === null && cur.predictedEndingBalance === null,
    `malformed bill (${label}): current-period bill load and Balance After Deductions are withheld, never $1,717.01 (fabricated $0 internet)`);
  ok(/Unavailable/.test(heroText(html)) && !html.includes('$1,632.01') && !html.includes('$1,717.01'),
    `malformed bill (${label}): active Budget hero renders Unavailable and prints neither stale $1,632.01 nor zero-coerced $1,717.01`);

  // Independent stocks and unaffected carriers stay preserved:
  ok(cur.currentBalance === EXPECT.canonicalChequing
    && adv.paydayAllocation.currentBalancePublication.amount === EXPECT.observedBillsCash
    && cur.budgetProgress.income.planned.amount === EXPECT.income
    && cur.budgetProgress.household.actual.amount === 444.49,
    `malformed bill (${label}): independent cash stocks (619.49 / 1,215), planned income (4,050), and observed grocery/fuel/dining spend (444.49) remain preserved`);
}

{
  // Bills page and Month view (Road Ahead) consumer checks on malformed bill:
  const data = fx.served();
  data.plan.bills.find(b => b.id === 'internet').amount = '1,900';
  budgetPage.render(data);
  const monthText = strip(budgetPage.monthViewHtml());
  ok(monthText.includes('A dated scheduled amount is missing or unparseable')
    && monthText.includes('Monthly planning is unavailable. This is not $0.'),
    'malformed bill ("1,900"): Budget Month view fails closed with explicit non-zero disclosure');

  const billsText = strip(billsPage.render(data)['bills-list'].innerHTML);
  ok(billsText.includes('Internet CONFIRMED Amount Unknown')
    && billsText.includes('Monthly equivalent Unknown')
    && billsText.includes('Mortgage CONFIRMED Amount $1,400.00')
    && billsText.includes('Hydro ESTIMATED Amount ≈ $120.00'),
    'malformed bill ("1,900"): Bills page marks Internet Amount & Monthly equivalent Unknown while preserving Mortgage ($1,400) and Hydro ($120)');

  const packet = Assistant.buildPacket({
    data, periods: null, questionsMarkdown: '', now: '2026-08-20T18:00:00.000Z', env: {},
  });
  ok(packet.uncertainty && packet.uncertainty.scheduledAmounts
    && packet.uncertainty.scheduledAmounts.status === 'unavailable'
    && packet.uncertainty.scheduledAmounts.unknowns.some(u => u.carrier === 'bill' && u.id === 'internet')
    && packet.forecast.horizon.minBalance === null,
    'malformed bill ("1,900"): Assistant context packet publishes uncertainty.scheduledAmounts and withholds horizon.minBalance');
}

console.log('\n=== 3. Malformed scheduled OBLIGATION amounts & Ruling C statement replacement ===');
for (const [label, badAmount] of MALFORMED_SHAPES) {
  const data = fx.served();
  data.plan.obligations.find(o => o.id === 'card-minimum').amount = badAmount;
  const html = budgetPage.render(data);
  const adv = budgetPage.context.__ctx.advice;
  const cur = adv.payPeriodViews.find(r => r.timelineRole === 'current');

  ok(adv.scheduledAmounts && adv.scheduledAmounts.status === 'unavailable'
    && adv.scheduledAmounts.unknowns.some(u => u.carrier === 'obligation' && u.id === 'card-minimum' && u.date === '2026-08-22'),
    `malformed obligation (${label}): scheduledAmounts names card-minimum on 2026-08-22`);
  ok(adv.weekly === null && adv.sim.totals.obligations === null
    && cur.periodBillLoad === null && cur.balanceAfterDeductions === null
    && /Unavailable/.test(heroText(html)),
    `malformed obligation (${label}): weekly cap, obligations total, periodBillLoad, and Budget hero Balance After Deductions withhold`);
  ok(cur.currentBalance === EXPECT.canonicalChequing && adv.sim.totals.bills === EXPECT.simBillsTotal91d,
    `malformed obligation (${label}): independent cash stock (619.49) and known 91-day bill total (4,935) stay intact`,
    `curBal=${cur.currentBalance} sim.totals.bills=${adv.sim.totals.bills}`);
}

{
  // Credit page consumer check when card-minimum obligation is malformed:
  const data = fx.served();
  data.plan.obligations.find(o => o.id === 'card-minimum').amount = null;
  const cardText = strip(creditPage.render(data)['credit-cards'].innerHTML);
  ok(cardText.includes('Posted balance $2,000.00')
    && cardText.includes('Credit limit $5,000.00')
    && cardText.includes('Available credit $3,000.00')
    && cardText.includes('Interest rate 19.99%')
    && cardText.includes('Minimum payment Unknown')
    && cardText.includes('Due date Unknown')
    && !cardText.includes('$60.00'),
    'malformed obligation (null): Credit page withholds Minimum payment & Due date as Unknown while preserving Posted balance ($2,000), Credit limit ($5,000), Available credit ($3,000), and APR (19.99%)');

  // Ruling C: a valid statement minimum on the current occurrence supersedes
  // the malformed fallback for the current pay-period waterfall, while the
  // wider horizon state still flags later occurrences that fall back to the
  // unparseable row amount.
  const statementReplaced = fx.served();
  const ob = statementReplaced.plan.obligations.find(o => o.id === 'card-minimum');
  ob.amount = '1,900';
  ob.confidence = 'estimated';
  ob.statementOccurrences = [{
    scheduledDate: '2026-08-22',
    dueDate: '2026-08-22',
    minimum: 60,
    currency: 'cad',
    confidence: 'confirmed',
  }];
  const curWindowState = F.scheduledAmountState(statementReplaced.plan, '2026-08-14', '2026-08-27', {});
  const fullWindowState = F.scheduledAmountState(statementReplaced.plan, '2026-08-20', '2026-10-31', {});
  budgetPage.render(statementReplaced);
  const advReplaced = budgetPage.context.__ctx.advice;
  const curReplaced = advReplaced.payPeriodViews.find(r => r.timelineRole === 'current');

  ok(curWindowState.status === 'ready' && curReplaced.periodBillLoad === EXPECT.billsTotal,
    'Ruling C statement replacement: valid Aug 22 statement minimum ($60) keeps the Aug 14–27 period bill load ready at $1,665.00',
    `status=${curWindowState.status} load=${curReplaced.periodBillLoad}`);
  ok(fullWindowState.status === 'unavailable'
    && fullWindowState.unknowns.every(u => u.date > '2026-08-27')
    && advReplaced.weekly === null,
    'Ruling C statement replacement: later Sept/Oct occurrences falling back to "1,900" still mark the multi-month horizon unavailable and withhold weekly spend');
}

console.log('\n=== 4. Malformed scheduled COMMITMENT amounts & dependency precision ===');
for (const [label, badAmount] of MALFORMED_SHAPES) {
  const data = fx.served();
  data.plan.commitments.find(c => c.id === 'school-trip').amount = badAmount;
  const html = budgetPage.render(data);
  const adv = budgetPage.context.__ctx.advice;
  const cur = adv.payPeriodViews.find(r => r.timelineRole === 'current');

  ok(adv.scheduledAmounts && adv.scheduledAmounts.status === 'unavailable'
    && adv.scheduledAmounts.unknowns.some(u => u.carrier === 'commitment' && u.id === 'school-trip' && u.date === '2026-09-12'),
    `malformed commitment (${label}): scheduledAmounts names school-trip on 2026-09-12`);
  ok(adv.weekly === null && adv.sim.totals.commitments === null
    && adv.planSpendPaydayFunding.status === 'unavailable'
    && adv.majorPlans.every(m => m.verdict === null && m.funded === null),
    `malformed commitment (${label}): weekly cap, commitments total, planSpendPaydayFunding, and majorPlans verdicts withhold`);
  // Dependency precision: a September commitment never enters the Aug 14-27
  // pay-period bill load or current-period Balance After Deductions!
  ok(cur.periodBillLoad === EXPECT.billsTotal
    && cur.balanceAfterDeductions === EXPECT.finalValid
    && heroText(html).includes('$1,632.01'),
    `malformed commitment (${label}): current-period bill load ($1,665.00) and Balance After Deductions ($1,632.01) do not depend on Sept commitment and remain published`);
}

{
  // Plan Spend page consumer check & Ruling B preserves (null+range, optional, undated, settled):
  const data = fx.served();
  data.plan.commitments.find(c => c.id === 'school-trip').amount = null;
  const spendText = strip(planSpendPage.render(data)['plan-spend-list'].innerHTML);
  ok(spendText.includes('Winter tires $900.00')
    && spendText.includes('STATUS UNAVAILABLE')
    && spendText.includes('Funding schedule unavailable for this cost.')
    && !spendText.includes('FEASIBLE IN CURRENT PLAN'),
    'malformed commitment (null): Plan Spend page retains Winter tires contractual need ($900.00) while withholding feasibility verdict as STATUS UNAVAILABLE');

  // Ruling B preserves on the same household fixture:
  const rangeData = fx.served();
  Object.assign(rangeData.plan.commitments.find(c => c.id === 'school-trip'), {
    amount: null, amountMin: 350, amountMax: 450,
  });
  ok(F.scheduledAmountState(rangeData.plan, rangeData.meta.asOf, '2026-11-19', {}).status === 'ready',
    'Ruling B preserve: dated commitment with null amount and valid [350, 450] range stays ready');

  const optionalData = fx.served();
  Object.assign(optionalData.plan.commitments.find(c => c.id === 'school-trip'), {
    amount: null, flexibility: 'optional',
  });
  ok(F.scheduledAmountState(optionalData.plan, optionalData.meta.asOf, '2026-11-19', {}).status === 'ready',
    'Ruling B preserve: optional dated commitment with null amount stays ready');

  const settledData = fx.served();
  Object.assign(settledData.plan.commitments.find(c => c.id === 'school-trip'), {
    amount: null, settledOn: '2026-08-18',
  });
  ok(F.scheduledAmountState(settledData.plan, settledData.meta.asOf, '2026-11-19', {}).status === 'ready',
    'Ruling B preserve: settled dated commitment with null amount stays ready');
}

console.log('\n=== 5. Transition lifecycle: malformed -> valid numeric 0 -> restored original amounts ===');
{
  // Step A: All three carriers malformed simultaneously
  const broken = fx.served();
  broken.plan.bills.find(b => b.id === 'internet').amount = '$85';
  broken.plan.obligations.find(o => o.id === 'card-minimum').amount = NaN;
  broken.plan.commitments.find(c => c.id === 'school-trip').amount = '';
  const brokenHtml = budgetPage.render(broken);
  const brokenAdv = budgetPage.context.__ctx.advice;
  const brokenCur = brokenAdv.payPeriodViews.find(r => r.timelineRole === 'current');
  const brokenCarriers = new Set((brokenAdv.scheduledAmounts?.unknowns || []).map(u => u.carrier));

  ok(brokenAdv.scheduledAmounts?.status === 'unavailable'
    && brokenCarriers.has('bill') && brokenCarriers.has('obligation') && brokenCarriers.has('commitment')
    && brokenCur.balanceAfterDeductions === null && /Unavailable/.test(heroText(brokenHtml)),
    'transition step A (all 3 carriers malformed): scheduledAmounts names bill, obligation, and commitment; Budget hero is Unavailable');

  // Step B: Transition internet bill to genuine numeric 0 and restore obligation/commitment
  const zeroBill = fx.served();
  zeroBill.plan.bills.find(b => b.id === 'internet').amount = 0;
  const zeroHtml = budgetPage.render(zeroBill);
  const zeroAdv = budgetPage.context.__ctx.advice;
  const zeroCur = zeroAdv.payPeriodViews.find(r => r.timelineRole === 'current');

  ok(zeroAdv.scheduledAmounts === undefined
    && zeroCur.periodBillLoad === EXPECT.billsZeroInternet
    && zeroCur.balanceAfterDeductions === EXPECT.finalZeroInternet
    && heroText(zeroHtml).includes('$1,717.01'),
    'transition step B (genuine numeric 0 bill): scheduledAmountState is ready and Budget hero publishes exact $1,717.01 (4,050 - 1,580 - 752.99)',
    `load=${zeroCur.periodBillLoad} bad=${zeroCur.balanceAfterDeductions}`);

  // Step C: Restore internet bill to 85 -> exact original figures return with no stale taint
  const restored = fx.served();
  const restoredHtml = budgetPage.render(restored);
  const restoredAdv = budgetPage.context.__ctx.advice;
  const restoredCur = restoredAdv.payPeriodViews.find(r => r.timelineRole === 'current');

  ok(restoredAdv.scheduledAmounts === undefined
    && restoredCur.periodBillLoad === EXPECT.billsTotal
    && restoredCur.balanceAfterDeductions === EXPECT.finalValid
    && heroText(restoredHtml).includes('$1,632.01')
    && typeof restoredAdv.weekly === 'number' && restoredAdv.weekly === 1045,
    'transition step C (restored 85 bill): all household figures recover to exact baseline ($1,665 load, $1,632.01 BAD, $1,045 weekly)',
    `load=${restoredCur.periodBillLoad} bad=${restoredCur.balanceAfterDeductions} weekly=${restoredAdv.weekly}`);
}

console.log('\n' + (failures ? `${failures} failure(s)` : 'All ATLAS-077 supplementary VM regression checks passed'));
process.exit(failures === 0 ? 0 : 1);
