'use strict';
/* AF-OPERATE-04 — the default between-paydays surface renders the incumbent
 * Forecast.currentPeriodAction result. Synthetic values are deliberately
 * unlike live household cents. The proof checks output identity and fail-closed
 * suppression; it does not call currentPeriodAction to verify itself.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

function loadRenderer() {
  const appSrc = read('public/app.js');
  const planSrc = read('public/plan.js');
  const grab = (src, re, label) => {
    const match = re.exec(src);
    if (!match) throw new Error('missing ' + label);
    return match[0];
  };
  const source = [
    grab(appSrc, /^const money = .*$/m, 'money'),
    grab(appSrc, /^const money2 = .*$/m, 'money2'),
    grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
    grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
    grab(planSrc, /^function paydayCoverageNote\([\s\S]*?\n\}/m, 'paydayCoverageNote'),
    grab(planSrc, /^function paydayAmountCell\([\s\S]*?\n\}/m, 'paydayAmountCell'),
    grab(planSrc, /^function currentPeriodConfidence\([\s\S]*?\n\}/m, 'currentPeriodConfidence'),
    grab(planSrc, /^function currentPeriodBillGroup\([\s\S]*?\n\}/m, 'currentPeriodBillGroup'),
    grab(planSrc, /^function betweenPaydaysOperatingHtml\([\s\S]*?\n\}/m, 'betweenPaydaysOperatingHtml'),
  ].join('\n');
  return vm.runInNewContext(`${source}\n({ betweenPaydaysOperatingHtml, money2 });`, { Forecast: require('../public/forecast') });
}

function action(extra) {
  return Object.assign({
    mode: 'between-paydays',
    asOf: '2026-09-08',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-14',
    nextPayday: '2026-09-15',
    coverage: {
      status: 'current', remainingClaim: 'precise', pendingStatus: 'complete',
      coverageStart: '2026-09-01', coverageThrough: '2026-09-08', reason: null,
    },
    bills: [], categories: [],
    unclassified: { posted: 0, pending: 0, count: 0 },
    weeklyCap: 321.45,
    spendPermission: 642.90,
    currentShortfall: false,
    todayActions: [], noMovementToday: true,
    remainingClaim: 'precise',
    categoryRemainingClaim: 'precise',
  }, extra || {});
}

const cap = { hasFeasibleCap: true, infeasible: false, reason: '' };
const renderer = loadRenderer();

console.log('=== bill states come only from Forecast.currentPeriodAction ===');
{
  const input = action({
    bills: [
      {
        id: 'represented-bill', label: 'Represented bill', date: '2026-09-03',
        planned: 100.12, actual: 91.23, remaining: 0,
        settlement: 'represented', confidence: 'confirmed',
      },
      {
        id: 'upcoming-bill', label: 'Upcoming bill', date: '2026-09-12',
        planned: 44.56, actual: 0, remaining: 44.56,
        settlement: 'upcoming', confidence: 'estimated',
      },
      {
        id: 'unverified-bill', label: 'Unverified bill', date: '2026-09-05',
        planned: 77.89, actual: null, remaining: 77.89,
        settlement: 'unverified', confidence: 'confirmed',
      },
    ],
  });
  const html = renderer.betweenPaydaysOperatingHtml(input, cap);
  for (const bill of input.bills) {
    ok(html.includes(`data-current-bill-id="${bill.id}"`)
      && html.includes(`data-current-bill-state="${bill.settlement}"`),
    `${bill.id} keeps Forecast settlement ${bill.settlement}`);
  }
  ok((html.match(/data-current-bill-id=/g) || []).length === input.bills.length,
    'the renderer adds no bill outside currentPeriodAction.bills');
  ok(html.indexOf('Handled / represented') < html.indexOf('Still due')
    && html.indexOf('Still due') < html.indexOf('Settlement unverified'),
  'represented, upcoming and unverified states remain separate');
  ok(html.includes(renderer.money2(91.23)) && html.includes(renderer.money2(100.12)),
    'represented actual and plan amount are the two incumbent bill fields');
  ok(/Upcoming bill[\s\S]*\$44\.56[\s\S]*estimated/.test(html),
    'an estimated due input stays visibly estimated');
  ok(/Settlement unverified\. This is not a claim that the bill is unpaid\./.test(html)
    && !/data-current-bill-state="unpaid"/.test(html),
  'unverified settlement is not collapsed into unpaid');

  const unknownHtml = renderer.betweenPaydaysOperatingHtml(action({ bills: [{
    id: 'unknown-bill', label: 'Unknown bill state', date: '2026-09-06',
    planned: 55.55, actual: null, remaining: 55.55,
    settlement: 'unknown-provider-state', confidence: 'unknown',
  }] }), cap);
  ok(/data-current-bill-group="unknown"/.test(unknownHtml)
    && /data-current-bill-state="unknown"/.test(unknownHtml)
    && /no handled or due claim is made/.test(unknownHtml)
    && !unknownHtml.includes(renderer.money2(55.55)),
  'an unresolved settlement state fails closed without a handled, due or amount claim');
}

console.log('\n=== category used and remaining values are direct ===');
{
  const input = action({
    categories: [{
      id: 'groceries', label: 'Groceries', class: 'essential',
      planned: 600, posted: 116.67, pending: 6.78,
      committed: 123.45, remaining: 456.78,
    }],
  });
  const html = renderer.betweenPaydaysOperatingHtml(input, cap);
  ok(html.includes('data-current-category-id="groceries"')
    && html.includes(`data-current-category-used>${renderer.money2(123.45)}`)
    && html.includes(`data-current-category-remaining>${renderer.money2(456.78)}`),
  'used and remaining are the currentPeriodAction category fields');
  ok(html.includes(`Includes observed pending ${renderer.money2(6.78)}`),
    'observed pending remains separately visible');
}

console.log('\n=== stale and incomplete coverage suppress exact category claims ===');
{
  for (const coverageCase of [
    { status: 'stale', reason: 'Transaction actuals are stale.' },
    { status: 'incomplete', reason: 'Transaction coverage starts after the period.' },
    { status: 'incomplete', reason: 'Posted transaction coverage is truncated.' },
    { status: 'incomplete', reason: 'A provider account is unresolved.' },
  ]) {
    const input = action({
      coverage: Object.assign({
        remainingClaim: 'unavailable', pendingStatus: 'unknown',
        coverageStart: null, coverageThrough: null,
      }, coverageCase),
      remainingClaim: 'unavailable',
      categoryRemainingClaim: 'unavailable',
      categories: [{
        id: 'sentinel', label: 'Sentinel category', class: 'essential',
        committed: 4567.89, remaining: 9876.54,
      }],
    });
    const html = renderer.betweenPaydaysOperatingHtml(input, cap);
    ok(!html.includes(renderer.money2(4567.89)) && !html.includes(renderer.money2(9876.54)),
      `${coverageCase.reason} suppresses used and remaining cents`);
    ok(/Exact category used and remaining amounts are unavailable/.test(html),
      `${coverageCase.reason} publishes the fail-closed limitation`);
  }
}

console.log('\n=== pending and classification limitations stay distinct ===');
{
  const postedOnly = action({
    coverage: {
      status: 'current', remainingClaim: 'posted-only', pendingStatus: 'partial',
      coverageStart: '2026-09-01', coverageThrough: '2026-09-08',
      reason: 'Pending coverage is not complete.',
    },
    remainingClaim: 'posted-only',
    categoryRemainingClaim: 'precise',
    categories: [{
      id: 'fuel', label: 'Fuel', class: 'essential',
      committed: 11.11, pending: 3.21, remaining: 88.76,
    }],
  });
  const postedHtml = renderer.betweenPaydaysOperatingHtml(postedOnly, cap);
  ok(postedHtml.includes(renderer.money2(88.76)) && /Observed remaining/.test(postedHtml),
    'posted-only remaining stays observed rather than exact');
  ok(/Additional unknown pending may exist/.test(postedHtml),
    'incomplete pending coverage remains explicit');

  const classification = action({
    categoryRemainingClaim: 'classified-incomplete',
    categories: [{
      id: 'shopping', label: 'Shopping', class: 'essential',
      committed: 22.22, pending: 0, remaining: 777.77,
    }],
    unclassified: { posted: 12.34, pending: 5.67, count: 2 },
  });
  const classificationHtml = renderer.betweenPaydaysOperatingHtml(classification, cap);
  ok(classificationHtml.includes(renderer.money2(22.22)),
    'classification-incomplete spending still shows the directly observed used amount');
  ok(!classificationHtml.includes(renderer.money2(777.77))
    && /Not precise/.test(classificationHtml)
    && /remaining amounts are withheld/.test(classificationHtml),
  'classification-incomplete spending suppresses precise named-category remaining');
  ok(classificationHtml.includes(renderer.money2(12.34))
    && classificationHtml.includes(renderer.money2(5.67)),
  'unclassified posted and pending stay separate rather than being page-summed');
}

console.log('\n=== weekly permission, dates and limitations are incumbent output ===');
{
  const input = action();
  const html = renderer.betweenPaydaysOperatingHtml(input, cap);
  ok(html.includes('data-current-weekly-permission>$321 / week'),
  'weekly permission is currentPeriodAction.weeklyCap');
  ok(html.includes('September 1') && html.includes('September 14'),
    'current pay-period range is currentPeriodAction.periodStart/periodEnd');
  ok(html.includes('data-current-next-payday>September 15 payday'),
    'next decision date is currentPeriodAction.nextPayday');
  ok(html.includes('Actual spending through Sep 8.'),
    'freshness copy reflects currentPeriodAction.coverage');
}

console.log('\n=== the homepage selects the daily renderer without changing payday ===');
{
  const src = read('public/plan.js');
  ok(/betweenPaydaysOperatingHtml\(action, capView\)/.test(src)
    && /paydayAllocationSummaryHtml\(alloc, action\)/.test(src)
    && /paydayAllocationSheetHtml\(alloc\)/.test(src),
    'between paydays selects currentPeriodAction; payday still selects the ordered allocation sheet');
  const html = read('public/index.html');
  ok(html.indexOf('id="operating-surface"') < html.indexOf('id="payday-answer"')
    && /id="payday-answer" hidden/.test(html)
    && !/View full current-period worksheet/.test(html),
  'AF-OPERATE-02 hierarchy stays first and the deeper worksheet is not on the default Plan');
  ok(/refreshTrustHtml\(ctx\.refreshTrust\)/.test(src)
    && /question\('01', 'Current Balance'/.test(src)
    && /question\('02', billsHeading/.test(src)
    && /question\('03', 'Balance after bills'/.test(src)
    && /question\('04', 'Household budget'/.test(src)
    && /question\('05', 'Balance after household budget'/.test(src)
    && !/question\('06', 'Credit card to pay off first'/.test(src)
    && /unavailableOperatingSurfaceHtml/.test(src),
    'fail-closed trust HTML remains on the unavailable surface; lookahead waterfall stops at household budget');
}

console.log('\n=== the page remains a renderer, not a calculator ===');
{
  const src = read('public/plan.js');
  const renderFn = /function betweenPaydaysOperatingHtml\([\s\S]*?\n\}/m.exec(src);
  const billFn = /function currentPeriodBillGroup\([\s\S]*?\n\}/m.exec(src);
  ok(renderFn && billFn, 'between-paydays rendering is bounded in named functions');
  const bounded = (renderFn ? renderFn[0] : '') + (billFn ? billFn[0] : '');
  ok(!/\bForecast\.[A-Za-z]+\s*\(/.test(bounded),
    'renderers call no Forecast function');
  ok(!/\.reduce\(|row\.planned\s*[-+]\s*row\.committed|row\.posted\s*\+\s*row\.pending|row\.remaining\s*[-+*/]/.test(bounded),
    'renderers contain no totals, remaining calculation or category accounting');
  ok(/row\.settlement === 'represented'/.test(renderFn[0])
    && /row\.committed/.test(renderFn[0])
    && /row\.remaining/.test(renderFn[0])
    && /action\.weeklyCap/.test(renderFn[0])
    && /action\.nextPayday/.test(renderFn[0]),
  'the renderer consumes currentPeriodAction fields directly');
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
