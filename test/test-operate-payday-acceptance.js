'use strict';
/* AF-OPERATE-07 — smallest missing acceptance proof for the complete
 * decision-first household operating experience.
 *
 * AF-OPERATE-01 through -06 already independently prove historical actuals,
 * the five-question surface, payday allocation identity, between-paydays
 * trust limits, future-gravity protection vs optional residual, and
 * required-debt vs extra-principal. This suite does not re-call those
 * Forecast authorities to "prove" themselves. It checks the composed
 * homepage contract that those slices left open: competing diagnostics are
 * collapsed, live overlay fail-closed is explicit, and the default surface
 * still renders incumbent answers without page-side arithmetic. `$0`
 * extra-debt allocation implies no extra-principal payment; it does not
 * imply that required contractual `requiredDebtPayments` disappear.
 */
const { loadBudgetPage, liveBudgetComposerSource } = require('./lib/budget-page-harness');
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');
const O = require('../scripts/provider-observe.js');
const data = require('../data.json');
const periods = require('../public/periods.json');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
const exists = file => fs.existsSync(path.join(__dirname, '..', file));

function loadComposer() {
  // The real Budget page (test/lib/budget-page-harness.js). operatingSurfaceHtml
  // is the live composition: the Today card plus the compact pay-period content.
  const page = loadBudgetPage({ Forecast: F, state: { scenario: null, targetBuffer: 500, extraDebtMonthly: 0, incomeOverrides: {}, disabled: [], debts: null, extraDebtTarget: null, extraFacilities: null } });
  return { operatingSurfaceHtml: ctx => page.surfaceHtml(ctx),
    paydayCashNote: page.get('paydayCashNote'), paydayGlanceCashNote: page.get('paydayGlanceCashNote'), paydayCoverageNote: page.get('paydayCoverageNote'), money: page.get('money'), money2: page.get('money2') };
}

function currentAdvice() {
  const plan = data.plan;
  const asOf = data.meta.asOf;
  const priority = F.debtPriority(plan, data.debts);
  const advice = F.recommend(plan, asOf, {
    scenario: 'expected',
    targetBuffer: plan.defaults.targetBuffer,
    extraDebtMonthly: 0,
    disabled: [],
    fundingSources: plan.funding && plan.funding.options,
    debts: data.debts,
    extraFacilities: data.revolvingExtra,
    extraDebtTarget: priority.target && priority.target.id,
    periods,
    paypalPerMonth: data.paypal && data.paypal.perMonth,
  });
  return { plan, asOf, priority, advice };
}

function independentAvailable(plan, asOf) {
  const opening = (plan.startingCash.breakdown || [])
    .filter(row => row && (row.id === 'chequing-a' || row.id === 'chequing-b'))
    .reduce((sum, row) => sum + Number(row.value || 0), 0);
  let sameDayIncome = 0;
  for (const row of plan.income || []) {
    if (row.frequency === 'once' && row.date === asOf) {
      sameDayIncome += Number(row.amount || 0);
    }
  }
  return opening + sameDayIncome;
}

function independentChequing(plan) {
  return (plan.startingCash.breakdown || []).reduce((sum, row) => {
    if (!row || (row.id !== 'chequing-a' && row.id !== 'chequing-b')) return sum;
    return sum + Number(row.value || 0);
  }, 0);
}

function independentHub(plan) {
  const rows = (plan.startingCash.breakdown || []).filter(row => row && row.id === 'chequing-a');
  if (rows.length !== 1) return null;
  const value = Number(rows[0].value);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function section(html, id) {
  const match = new RegExp(`<section id="${id}"[\\s\\S]*?<\\/section>`).exec(html);
  return match ? match[0] : '';
}

function liveGlance(html) {
  const start = html.indexOf('data-live-current-balance');
  if (start < 0) return '';
  const end = html.indexOf('</div>', start);
  return html.slice(start, end < 0 ? html.length : end + 6);
}

function question(html, number) {
  const start = html.indexOf(`data-operating-question="${number}"`);
  if (start < 0) return '';
  const end = html.indexOf('data-operating-question=', start + 1);
  const certainty = html.indexOf('data-operating-certainty', start + 1);
  const warnings = html.indexOf('data-operating-warnings', start + 1);
  const allocation = html.indexOf('data-payday-allocation-details', start + 1);
  let stop = html.length;
  if (end >= 0) stop = end;
  if (certainty >= 0 && certainty < stop) stop = certainty;
  if (warnings >= 0 && warnings < stop) stop = warnings;
  if (allocation >= 0 && allocation < stop) stop = allocation;
  return html.slice(start, stop);
}

const PRIOR_SUITES = [
  ['AF-OPERATE-01', 'test-periods-lunchmoney.js'],
  ['AF-OPERATE-02', 'test-operating-surface.js'],
  ['AF-OPERATE-03', 'test-operate-payday-action-sheet.js'],
  ['AF-OPERATE-05', 'test-operate-future-gravity.js'],
  ['AF-OPERATE-06', 'test-operate-debt-answer.js'],
];

console.log('=== campaign closeout and prior-slice proofs remain ===');
{
  const registry = new Set(require('./suites.json').map(([, file]) => file));
  for (const [id, file] of PRIOR_SUITES) {
    ok(exists(path.join('test', file)), `${id} independent proof ${file} remains as regression`);
    ok(registry.has(file), `${id} stays registered in npm test`);
  }
  ok(exists('docs/AF_OPERATE_PAYDAY_OPERATING_SURFACE_PLAN.md') === false,
    'the temporary AF-OPERATE campaign plan is deleted');
  ok(!exists('docs/.AF_OPERATE_07_DISPATCH.md'),
    'the temporary AF-OPERATE-07 dispatch file is deleted');
  ok(!exists('docs/AF_REFRESH_TRUSTED_STATE_LOOP_PLAN.md'),
    'the temporary AF-REFRESH campaign plan is deleted');
}

console.log('\n=== default homepage answers the operating questions first ===');
{
  const html = read('public/index.html');
  const operatingAt = html.indexOf('id="operating-surface"');
  const worksheetAt = html.indexOf('id="payday-answer"');
  const roadAt = html.indexOf('id="road-ahead"');
  // Display tidy-up: the page footer (privacy paragraph) left index.html; the
  // page now ends at the tooltip mount.
  const footerAt = html.indexOf('<div class="tip" id="tip">');
  const defaultSurface = html.slice(operatingAt, roadAt);
  const roadHead = html.slice(roadAt, html.indexOf('id="outlook"'));
  const road = html.slice(roadAt, footerAt);
  ok(operatingAt >= 0 && worksheetAt > operatingAt && roadAt > worksheetAt && footerAt > roadAt,
    'operating surface leads; diagnostic mounts remain after it and before the end of the page');
  ok(!html.includes('<footer') && !html.includes('No account numbers, card numbers or addresses'),
    'the Budget page carries no privacy footer');
  ok(!/<h1>This payday<\/h1>/.test(defaultSurface)
    && (html.match(/<h1[\s>]/g) || []).length === 0,
  'the Budget operating surface has no page h1');
  const worksheet = section(html, 'payday-answer');
  ok(worksheet && /hidden/.test(worksheet)
    && !/View full current-period worksheet/.test(worksheet),
  'the current-period worksheet is not rendered on the default Plan page');
  ok(!/<summary>Why \/ Road ahead<\/summary>/.test(html)
    && /id="road-ahead"[^>]*hidden/.test(html),
  'Why / Road ahead is not a default Plan disclosure');
  const competing = [
    'nextmove-card', 'hero-tiles', 'cap-headline', 'major-plans-list',
    'risk-list', 'plan-mission', 'snapshot-tiles',
  ];
  for (const id of competing) {
    ok(road.includes(`id="${id}"`) && !defaultSurface.includes(`id="${id}"`),
      `competing diagnostic ${id} lives after the operating surface, not on the default Plan`);
  }
  ok(!/<nav class="sitenav/.test(html),
    'Budget has no page nav');
}

console.log('\n=== composed surface: cash, identity, debt, protection, limits ===');
{
  const { plan, asOf, priority, advice } = currentAdvice();
  const composer = loadComposer();
  const alloc = advice.paydayAllocation;
  const action = advice.currentPeriodAction;
  const rendered = composer.operatingSurfaceHtml({
    plan, asOf, advice, weekly: advice.weekly, recommended: advice.weekly,
    liveOverlay: data.liveOverlay,
  });
  const independentCash = independentAvailable(plan, asOf);
  const independentPostedChequing = independentChequing(plan);
  const independentPostedHub = independentHub(plan);
  const creditHeadroom = (data.revolvingExtra || []).reduce((sum, row) => {
    const limit = Number(row && row.limit);
    return sum + (isFinite(limit) ? limit : 0);
  }, 0);
  const lineSum = (alloc.lines || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const extraLine = (alloc.lines || []).find(row => row && row.key === 'extra-debt');
  const requiredItems = (alloc.requiredDebtPayments && alloc.requiredDebtPayments.items) || [];
  const live = liveGlance(rendered);
  const q2 = question(rendered, '02');
  const q4 = question(rendered, '04');
  const q5 = question(rendered, '05');
  const q6 = question(rendered, '06');
  const q8 = question(rendered, '08');

  ok(action && action.mode === 'between-paydays',
    'the dated opening is between paydays');
  // Live Budget: the Today card header names it "Current balance".
  ok(/data-live-current-balance/.test(live) && /<h2>Current balance<\/h2>/.test(live),
    'live Current Balance sits outside the payday snapshot');
  ok(/data-payday-period-bills/.test(q4),
    'Q4 publishes bills this pay period');
  ok(/data-running-leftover/.test(q5),
    'Q5 publishes leftover after bills');
  ok(/data-payday-household-budget/.test(q6) || /Household budget/.test(q6),
    'Q6 publishes household budget');
  ok(!/data-payday-decision/.test(rendered) && !/See how payday is reserved/.test(rendered),
    'the payday allocation disclosure is not on the default Plan');
  ok(!/data-current-period-action/.test(rendered)
      && !/See current-period details/.test(rendered),
    'between-paydays worksheet details stay off the default Plan');
  ok(near(independentCash, alloc.available),
    'available cash independently equals spendable opening plus same-day income');
  ok(creditHeadroom > 0 && alloc.available + 0.005 < independentCash + creditHeadroom,
    'available credit is not treated as household cash');
  ok(independentPostedHub != null
    && live.includes(composer.money2(independentPostedHub))
    && /<h2>Current balance<\/h2>/.test(live)
    && !live.includes(composer.money2(independentPostedChequing))
    && !/live Lunch Money overlay/.test(live)
    && !/Available in chequing/.test(live),
  'live Current Balance publishes independent hub (chequing-a) cash, not pooled A+B, not credit, not an available-in-chequing headline, and not live overlay');
  ok(near(lineSum, alloc.allocatedTotal)
    && near(lineSum + Number(alloc.remainder), alloc.available),
  'independent allocation-line sum plus remainder equals available resources');
  ok(near(action.weeklyCap, advice.weekly)
    && !rendered.includes(`${composer.money(action.weeklyCap)} / week`),
  'this week\'s spend stays Forecast.recommend.weekly and is not dumped onto the default Plan');
  ok(!/See later bills and big purchases/.test(rendered)
      && !/Big-purchase savings/.test(rendered)
      && !/data-payday-big-purchases/.test(rendered),
    'later-bills inventory dump and the big-purchase row stay off the default Plan');
  for (const item of requiredItems) {
    ok(q4.includes(item.label) && q4.includes(composer.money2(item.amount)),
      `Q4 required debt ${item.id} is the Forecast required item, not extra principal`);
    if (item.confidence === 'estimated') {
      ok(/about /.test(q4),
        `Q4 marks estimated ${item.id} as about`);
    }
    ok(!/unverified/.test(q4.replace(/<[^>]*>/g, '')),
      `Q4 does not print settlement code words for ${item.id}`);
  }
  ok(requiredItems.length >= 1,
    'Forecast still exposes requiredDebtPayments separately from extra principal');
  const extraAllocated = Number(alloc.extraDebt.allocated);
  ok((extraAllocated === 0 && !extraLine)
    || (extraLine && near(extraLine.amount, extraAllocated)),
    'zero extra principal adds no extra-debt line; a positive extra line equals Forecast.extraDebt.allocated');
  ok(/data-operating-question="07"/.test(rendered)
    && !q8
    && !/Pay extra/.test(rendered)
    && !/Extra debt money this payday goes to/.test(rendered),
  'the default Plan ends at Q7 and prints no extra-repayment instruction');
  if (extraAllocated > 0) {
    ok(alloc.extraDebt.target && alloc.extraDebt.target.label
      && !rendered.includes(alloc.extraDebt.target.label),
    'positive extra principal stays a Forecast decision and is not printed on the default Plan');
  }
  ok(priority.status === 'ready' && priority.target
    && plan.nextDollar && plan.nextDollar.policy === 'true-surplus-highest-interest'
    && plan.nextDollar.target == null,
  'debt target comes from Forecast.debtPriority plus recorded owner policy, not a stored rank');
  const coverage = composer.paydayCoverageNote(action);
  const remainingUnavailable = !action || action.remainingClaim === 'unavailable';
  ok(remainingUnavailable
      && /Transaction actuals were not supplied|unavailable|through/.test(coverage),
    'Forecast remainingClaim stays unavailable on the committed opening');
  ok(!/data-operating-warnings/.test(rendered)
      && !rendered.includes(coverage)
      && !/There is no feasible weekly cap/.test(rendered),
    'unavailable remaining is not printed as an advisory on the default Plan');
  ok(!/data-operating-certainty/.test(rendered)
      && !/How sure is this\?/.test(rendered),
    'the generic certainty disclosure is not on the default Plan');
  ok(!data.liveOverlay,
    'the committed opening carries no applied live overlay to mistake for current live truth');
}

console.log('\n=== $0 extra-debt allocation does not erase required debt ===');
{
  const { advice } = currentAdvice();
  const composer = loadComposer();
  const required = ((advice.paydayAllocation.requiredDebtPayments
    && advice.paydayAllocation.requiredDebtPayments.items) || [])
    .filter(item => item && item.label && item.amount != null);
  ok(required.length >= 1,
    'the incumbent result still has requiredDebtPayments to preserve');
  const zeroAdvice = JSON.parse(JSON.stringify(advice));
  zeroAdvice.paydayAllocation.extraDebt.allocated = 0;
  const q4 = question(composer.operatingSurfaceHtml({
    advice: zeroAdvice, weekly: zeroAdvice.weekly, recommended: zeroAdvice.weekly,
  }), '04');
  const q6 = question(composer.operatingSurfaceHtml({
    advice: zeroAdvice, weekly: zeroAdvice.weekly, recommended: zeroAdvice.weekly,
  }), '06');
  for (const item of required) {
    ok(q4.includes(item.label) && q4.includes(composer.money2(item.amount)),
      `$0 extra principal still publishes required debt ${item.id}`);
  }
  ok(!q6.includes('No extra debt this payday.'),
  '$0 extra-debt allocation does not replace household budget');
  ok(!/Pay extra/.test(q6)
    && !/Extra debt money this payday goes to/.test(q6),
  '$0 extra-debt allocation implies no extra-principal payment');
  ok(!/Nothing else has to leave this payday/.test(q4)
    && /data-payday-period-bills/.test(q4),
  '$0 extra principal leaves this-period bills visible');
}

console.log('\n=== payday mode still uses the ordered allocation sheet ===');
{
  const { advice } = currentAdvice();
  const composer = loadComposer();
  const paydayAdvice = JSON.parse(JSON.stringify(advice));
  paydayAdvice.currentPeriodAction = Object.assign({}, paydayAdvice.currentPeriodAction, {
    mode: 'payday',
    todayActions: [],
    noMovementToday: false,
  });
  const html = composer.operatingSurfaceHtml({
    advice: paydayAdvice, weekly: paydayAdvice.weekly, recommended: paydayAdvice.weekly,
  });
  const live = liveGlance(html);
  const q4 = question(html, '04');
  const q6 = question(html, '06');
  const q8 = question(html, '08');
  ok(/data-live-current-balance/.test(live) && !/data-allocation-available/.test(live),
    'payday-mode live Current Balance stays outside the allocation sheet');
  ok(/data-payday-period-bills/.test(q4),
    'payday-mode Q4 is bills');
  ok(/data-payday-household-budget/.test(q6) || /Household budget/.test(q6),
    'payday-mode Q6 is household budget');
  ok(!q8 && !/data-payday-first-card/.test(html) && !/data-allocation-available/.test(html)
      && !/See how payday is reserved/.test(html),
    'a payday-mode result stops at the household-budget boundary and does not dump the allocation sheet onto the default Plan');
  ok(/<h2>Current balance<\/h2>/.test(html) && /Household budget/.test(html)
    && />Bills</.test(html)
    && /Balance After Deductions/.test(html)
    && !/Predicted Ending Balance/.test(html)
    && !/Extra credit-card repayment/.test(html),
  'payday mode still answers Current Balance, bills, budget, and Balance After Deductions');
}

console.log('\n=== live overlay cannot be authorized from committed git state ===');
{
  const committedMap = require('../docs/connectivity/provider-account-map.json');
  ok(Array.isArray(committedMap.mappings) && committedMap.mappings.length === 0,
    'the committed Lunch Money map contains no live account IDs');
  let reason = '';
  try {
    O.assertLiveMap(committedMap);
  } catch (err) {
    reason = String(err && err.message || err);
  }
  ok(/missing-required-cash-mapping/.test(reason),
    'the committed map fails closed and cannot authorize a live overlay',
    reason);
  ok(!exists('docs/connectivity/provider-account-map.local.json'),
    'this checkout has no local live account map');
  const composer = loadComposer();
  const note = composer.paydayGlanceCashNote({
    available: 100, asOf: data.meta.asOf, cashBasis: { asOf: data.meta.asOf },
  });
  ok(/Current Balance\. Not credit\./.test(note)
    && !/live Lunch Money overlay/.test(note)
    && !/dated opening/.test(note),
  'absent overlay evidence is Current Balance, not current live truth');
  const glance = composer.operatingSurfaceHtml({
    advice: {
      weekly: 180,
      paydayAllocation: {
        available: 100, asOf: data.meta.asOf, cashBasis: { asOf: data.meta.asOf },
        extraDebt: { allocated: 0 }, obligations: { items: [] },
        futureCosts: [], unresolved: [], risks: [],
      },
      currentPeriodAction: { mode: 'between-paydays', nextPayday: '2026-09-11', bills: [], todayActions: [] },
    },
    weekly: 180, recommended: 180,
    liveOverlay: { applied: false, reason: 'stale-live-cash-evidence' },
  });
  const q1 = question(glance, '01');
  ok(/Current Balance\. Not credit\./.test(q1) && !/overlay/.test(q1),
    'a refused overlay does not leak overlay jargon onto Current Balance');
}

console.log('\n=== the composed page remains a renderer ===');
{
  const planSrc = read('public/plan.js');
  const fn = liveBudgetComposerSource(planSrc);
  ok(!!fn, 'the live Budget composer remains a set of bounded formatters');
  ok(fn && !/\bForecast\.[A-Za-z]+\s*\(/.test(fn[0]),
    'the composed formatter calls no Forecast function');
  ok(fn && !/\.reduce\(|monthlyFromWeekly|projectDebts|fundingSequence/.test(fn[0]),
    'the composed formatter contains no page-side totals, conversions, or debt walk');
  const remount = /^function budgetRemount\([\s\S]*?\n\}/m.exec(planSrc);
  ok(/budgetRemount\(operatingMount, surfaceCtx\)/.test(planSrc)
    && remount && /mount\.innerHTML = budgetSurfaceHtml\(ctx\)/.test(remount[0])
    && !/\bForecast\.|\.reduce\(|monthlyFromWeekly|projectDebts|fundingSequence/.test(remount[0])
    && /refreshTrust: d\.refreshTrust/.test(planSrc),
  'renderPlan retains incumbent recommendation and refresh trust through the active renderer remount without page-side financial calculation');
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
