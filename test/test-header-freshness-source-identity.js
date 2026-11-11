'use strict';
/* Shared #asof chip: historical spending series vs live overlay spending.
 *
 * Adversarial case: Forecast as-of is September, periods.json history is
 * August 24, and live overlay current-period txs are dated September.
 * Budget Spent lists those September txs. The header must not let
 * "spending history as at August 24" describe that Spent evidence.
 *
 * Presentation of published dates only. Spent membership stays Forecast
 * classifyCurrentPeriodTransaction / withheld-Spent overlay listing (L-001).
 * Independent arithmetic for the Spent total (L-002 / L-006). No live cents.
 *
 * `node test/test-header-freshness-source-identity.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;

function grab(src, re, label) {
  const match = re.exec(src);
  if (!match) throw new Error('missing ' + label);
  return match[0];
}

const appSrc = read('public/app.js');
const planSrc = read('public/plan.js');

const chip = vm.runInNewContext(
  [
    grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
    grab(appSrc, /^function chipIsoDate\([\s\S]*?\n\}$/m, 'chipIsoDate'),
    grab(appSrc, /^function liveSpendingEvidenceDate\([\s\S]*?\n\}$/m, 'liveSpendingEvidenceDate'),
    grab(appSrc, /^function formatSiteAsOfChip\([\s\S]*?\n\}$/m, 'formatSiteAsOfChip'),
    '\n({ formatSiteAsOfChip, liveSpendingEvidenceDate, chipIsoDate, fmtDateLong });',
  ].join('\n'),
  {}
);

const composer = vm.runInNewContext(
  [
    grab(appSrc, /^const money = .*$/m, 'money'),
    grab(appSrc, /^const money2 = .*$/m, 'money2'),
    grab(appSrc, /^const escapeHtml = .*$/m, 'escapeHtml'),
    grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
    grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
    grab(planSrc, /^function paydayBucketRow\([\s\S]*?\n\}$/m, 'paydayBucketRow'),
    grab(planSrc, /^function householdBudgetCycleText\([\s\S]*?\n\}$/m, 'householdBudgetCycleText'),
    grab(planSrc, /^function householdBudgetMetric\([\s\S]*?\n\}$/m, 'householdBudgetMetric'),
    grab(planSrc, /^function householdBudgetCategoryHtml\([\s\S]*?\n\}$/m, 'householdBudgetCategoryHtml'),
    grab(planSrc, /^function calendarCurrentUnavailableHtml\([\s\S]*?\n\}$/m, 'calendarCurrentUnavailableHtml'),
    grab(planSrc, /^function calendarBudgetHtml\([\s\S]*?\n\}$/m, 'calendarBudgetHtml'),
    '\n({ calendarBudgetHtml, householdBudgetMetric, money2 });',
  ].join('\n'),
  { Forecast: F }
);

const AS_OF = '2026-09-19';
const HISTORY_AS_OF = '2026-08-24';
const GROCERY = 42.10;
const GROCERY_PLANNED = 450;

function syntheticPlan() {
  return {
    defaults: { targetBuffer: 500 },
    startingCash: {
      breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 8000 }],
    },
    opening: { asOf: AS_OF, representedEvents: [] },
    income: [{
      id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
      anchor: '2026-08-14', amount: 4264, confidence: 'confirmed',
    }],
    bills: [],
    obligations: [],
    commitments: [],
    budget: {
      categories: [
        { id: 'groceries', label: 'Groceries', class: 'essential', plannedWeekly: 225, ownerLine: 'Groceries' },
      ],
    },
  };
}

const septemberTx = {
  id: 'tx-groc-sep',
  date: '2026-09-12',
  amount: GROCERY,
  pending: false,
  categoryLabel: 'Groceries',
  accountRole: 'household-cash',
  displayedPayee: 'Save-On-Foods',
  originalMerchant: 'Save-On-Foods',
};

function mixedOverlay(extraActuals) {
  return {
    applied: true,
    observedAsOf: AS_OF,
    fetchedAt: '2026-09-19T18:44:00.000Z',
    currentPeriodActuals: Object.assign({
      schema: 'atlas-current-period-actuals/v1',
      observationAsOf: AS_OF,
      coverageStart: '2026-09-11',
      coverageThrough: AS_OF,
      transactions: [septemberTx],
    }, extraActuals || {}),
  };
}

function withheldPeriod() {
  return {
    id: 'this-pay-period',
    role: 'active',
    start: '2026-09-11',
    end: '2026-09-24',
    spendingCycle: { start: '2026-09-11', end: '2026-09-24', rangeLabel: '11 Sep – 24 Sep' },
    householdBudget: [
      { id: 'groceries', label: 'Groceries', planned: GROCERY_PLANNED, spent: null, remaining: GROCERY_PLANNED, recon: [] },
    ],
    budgetHold: GROCERY_PLANNED,
  };
}

function block(html, id) {
  const marker = `data-budget-category="${id}"`;
  const at = html.indexOf(marker);
  if (at < 0) return '';
  const from = html.lastIndexOf('<div', at);
  const next = html.indexOf('data-budget-category="', at + marker.length);
  if (next < 0) return html.slice(from);
  const to = html.lastIndexOf('<div', next);
  return html.slice(from, to > from ? to : next);
}

function txIds(html) {
  return [...html.matchAll(/data-tx-id="([^"]+)"/g)].map(m => m[1]);
}

function txDates(html) {
  return [...html.matchAll(/datetime="([^"]+)"/g)].map(m => m[1]);
}

// Frozen copy of public/app.js boot wording on main cc62a7d, before this
// repair. Independent of formatSiteAsOfChip (L-002).
function preFixChip(data, periods) {
  const fmtDateLong = chip.fmtDateLong;
  let text = 'As at ' + fmtDateLong(data.meta.asOf);
  if (periods && periods.asOf && periods.asOf !== data.meta.asOf) {
    text += ' · spending history as at ' + fmtDateLong(periods.asOf);
  }
  const overlay = data.liveOverlay;
  if (overlay && overlay.applied) {
    const observed = overlay.observedAsOf && overlay.observedAsOf !== data.meta.asOf
      ? fmtDateLong(overlay.observedAsOf)
      : null;
    text += observed
      ? ' · live balances observed ' + observed
      : ' · live Lunch Money overlay';
  } else if (overlay && overlay.applied === false) {
    const opening = overlay.historicalOpeningAsOf || data.meta.asOf;
    text += opening
      ? ' · live overlay not applied · using the ' + fmtDateLong(opening) + ' opening'
      : ' · live overlay not applied';
  }
  return text;
}

const mixedData = {
  meta: { asOf: AS_OF },
  liveOverlay: mixedOverlay(),
};
const history = { asOf: HISTORY_AS_OF };
const plan = syntheticPlan();

console.log('\n=== 1. pre-fix chip associates August history with undated overlay ===');
{
  const oldChip = preFixChip(mixedData, history);
  ok(oldChip === 'As at September 19 · spending history as at August 24 · live Lunch Money overlay',
    'pre-fix mixed chip is the adversarial wording',
    oldChip);
  ok(/spending history as at August 24/.test(oldChip)
      && /live Lunch Money overlay/.test(oldChip)
      && !/live spending through/.test(oldChip),
    'pre-fix hides overlay evidence date when observedAsOf equals as-of');
}

console.log('\n=== 2. same fixture lists September overlay txs as Budget Spent ===');
{
  ok(F.classifyCurrentPeriodTransaction(septemberTx, plan).categoryId === 'groceries',
    'Forecast classifies the September grocery tx as groceries');
  const html = composer.calendarBudgetHtml(withheldPeriod(), mixedOverlay(), plan);
  const groceries = block(html, 'groceries');
  ok(/<details class="household-budget-spent-detail" data-budget-spent="groceries">/.test(groceries)
      && txIds(groceries).join() === 'tx-groc-sep'
      && txDates(groceries).join() === '2026-09-12'
      && groceries.includes(composer.money2(GROCERY)),
    'Budget Spent expands the September overlay grocery tx');
  const classified = F.classifyCurrentPeriodTransaction(septemberTx, plan);
  ok(classified.categoryId === 'groceries' && roundCent(septemberTx.amount) === GROCERY,
    'independent Forecast membership + amount still equal the disclosed Spent row');
}

console.log('\n=== 3. repair distinguishes historical series from live overlay spending ===');
{
  const next = chip.formatSiteAsOfChip(mixedData, history);
  ok(next === 'As at September 19 · historical spending through August 24 · live spending through September 19',
    'mixed chip names each source with its own date',
    next);
  ok(/historical spending through August 24/.test(next),
    'August 24 remains attached only to historical spending');
  ok(/live spending through September 19/.test(next),
    'September overlay evidence is dated from the actuals packet');
  ok(!/spending history as at/.test(next),
    'retired wording is gone');
  const augustOnly = next.match(/August 24/g) || [];
  ok(augustOnly.length === 1 && !/live spending through August/.test(next),
    'August 24 does not appear on the live-spending clause');
}

console.log('\n=== 4. Spent amounts, membership, and dates stay unchanged ===');
{
  const html = composer.calendarBudgetHtml(withheldPeriod(), mixedOverlay(), plan);
  const groceries = block(html, 'groceries');
  ok(txIds(groceries).join() === 'tx-groc-sep'
      && txDates(groceries).join() === '2026-09-12'
      && groceries.includes(composer.money2(GROCERY))
      && groceries.includes(composer.money2(GROCERY_PLANNED)),
    'Spent disclosure still lists the same September tx, amount, and planned');
  const chipSrc = grab(appSrc, /^function formatSiteAsOfChip\([\s\S]*?\n\}$/m, 'formatSiteAsOfChip');
  const evidenceSrc = grab(appSrc, /^function liveSpendingEvidenceDate\([\s\S]*?\n\}$/m, 'liveSpendingEvidenceDate');
  ok(!/classifyCurrentPeriodTransaction|householdBudgetMetric/.test(chipSrc + evidenceSrc)
      && !/\.spent\b|\.remaining\b|\.amount\b/.test(chipSrc + evidenceSrc),
    'chip helpers do not classify, sum, or reprint Spent');
}

console.log('\n=== 5. coverageThrough wins; fetchedAt is never freshness ===');
{
  const lagged = {
    meta: { asOf: AS_OF },
    liveOverlay: mixedOverlay({ coverageThrough: '2026-09-18' }),
  };
  const next = chip.formatSiteAsOfChip(lagged, history);
  ok(/live spending through September 18/.test(next)
      && !/live spending through September 19/.test(next),
    'live spending uses coverageThrough, not as-of or fetch time',
    next);
  ok(chip.liveSpendingEvidenceDate({
    applied: true,
    observedAsOf: AS_OF,
    fetchedAt: '2026-09-19T18:44:00.000Z',
    currentPeriodActuals: { coverageThrough: '2026-09-18' },
  }) === '2026-09-18',
    'evidence helper reads coverageThrough and ignores fetchedAt');
  ok(chip.liveSpendingEvidenceDate({
    applied: true,
    fetchedAt: '2026-09-19T18:44:00.000Z',
    currentPeriodActuals: { fetchedAt: '2026-09-19' },
  }) === null,
    'fetchedAt is not an evidence date even when shaped like YYYY-MM-DD on the packet');
  ok(chip.chipIsoDate('2026-09-19T18:44:00.000Z') === null
      && chip.chipIsoDate('2026-09-19') === '2026-09-19',
    'timestamp prefixes are not household dates');
}

console.log('\n=== 6. fail closed when overlay evidence date is unavailable ===');
{
  const undated = {
    meta: { asOf: AS_OF },
    liveOverlay: {
      applied: true,
      observedAsOf: AS_OF,
      fetchedAt: '2026-09-19T18:44:00.000Z',
      currentPeriodActuals: { transactions: [septemberTx] },
    },
  };
  const next = chip.formatSiteAsOfChip(undated, history);
  ok(next === 'As at September 19 · historical spending through August 24 · live Lunch Money overlay',
    'undated overlay stays undated rather than inventing September from fetch time',
    next);
  const unapplied = chip.formatSiteAsOfChip({
    meta: { asOf: '2026-08-19' },
    liveOverlay: { applied: false, historicalOpeningAsOf: '2026-08-19' },
  }, history);
  ok(unapplied === 'As at August 19 · historical spending through August 24 · live overlay not applied · using the August 19 opening',
    'unapplied overlay wording stays the dated opening, not a live-spend claim',
    unapplied);
  const balancesOnly = chip.formatSiteAsOfChip({
    meta: { asOf: '2026-08-19' },
    liveOverlay: { applied: true, observedAsOf: AS_OF, fetchedAt: '2026-09-19T18:44:00.000Z' },
  }, history);
  ok(balancesOnly === 'As at August 19 · historical spending through August 24 · live balances observed September 19',
    'observedAsOf that is not spending coverage keeps live-balances wording',
    balancesOnly);
  const noHistory = chip.formatSiteAsOfChip(mixedData, null);
  ok(noHistory === 'As at September 19 · live spending through September 19',
    'pages that do not load periods still date live spending and omit history',
    noHistory);
}

console.log('\n=== 7. shared seam — boot reprints the helper; pages do not format as-of ===');
{
  ok(/asof\.textContent = formatSiteAsOfChip\(d, PERIODS\)/.test(appSrc),
    'App.boot writes #asof from formatSiteAsOfChip');
  const pageFiles = [
    'public/plan.js',
    'public/plan-spend.js',
  ];
  const pageHits = pageFiles.filter(file => /spending history as at|formatSiteAsOfChip/.test(read(file)));
  ok(pageHits.length === 0,
    'page scripts do not patch freshness copy',
    pageHits.join(', ') || 'none');
  ok(/App\.boot\(\{ periods: true/.test(read('public/plan.js')),
    'Budget still loads periods into the shared chip');
}

if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nheader freshness source identity: ok');
