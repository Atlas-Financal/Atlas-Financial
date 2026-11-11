'use strict';
/* Budget timeline: Plan Spend earmark on the pay-period timeline.
 *
 * The Budget waterfall ends at Balance After Deductions (B98). This test
 * proves the timeline reprints Forecast's planSpendPaydayFunding
 * contribution for the payday starting the selected period — outside the
 * Q01–Q07 waterfall — so the household sees how much of the leftover is
 * already earmarked for named future costs. Presentation only: the page
 * does no arithmetic; amounts are copied from the Forecast schedule.
 *
 * `node test/test-budget-plan-spend-earmark.js`
 */
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { sourceText } = require('./test-source-text');
const source = sourceText(fs.readFileSync(path.join(__dirname, '../public/plan.js'), 'utf8'));
const context = vm.createContext({ escapeHtml: require('./app-escape-html'),
  fmtDate: value => value,
  fmtDateLong: value => value,
  money2: n => (n < 0 ? '−$' : '$') + Math.abs(Number(n)).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  liveCurrentBalanceHtml: () => '<div data-live-current-balance>cash</div>',
  calendarWaterfallHtml: () => '<article data-waterfall>waterfall</article>',
  periodBillLine: () => '',
});
vm.runInContext(source, context);
vm.runInContext(`
  calendarWaterfallHtml = () => '<article data-waterfall>waterfall</article>';
  liveCurrentBalanceHtml = () => '<div data-live-current-balance>cash</div>';
`, context);
const f = context;

const period = (id, start, end, role) => Object.freeze({
  id, start, end, rangeLabel: `${start} – ${end}`, timelineRole: role,
  balanceAfterDeductions: 2064.28,
});
const periods = Object.freeze([
  period('future:2026-10-09', '2026-10-09', '2026-10-22', 'future'),
  period('future:2026-10-23', '2026-10-23', '2026-11-05', 'future'),
  period('future:2026-11-06', '2026-11-06', '2026-11-19', 'future'),
]);
const schedule = status => ({
  status,
  asOf: '2026-08-19',
  paydays: [
    {
      payday: '2026-10-23',
      contribution: 1200,
      allocations: [
        { id: 'fusion-household-oct', label: 'Fusion season — household (October)', amount: 1200 },
      ],
      protectedAfterPayday: 1200,
      stillToFund: 22831.76,
    },
    { payday: '2026-11-06', contribution: 0, allocations: [], protectedAfterPayday: 0, stillToFund: 22831.76 },
  ],
});
const adviceFor = (periodId, planSpendPaydayFunding) => ({
  payPeriodViews: periods,
  defaultView: { asOf: '2026-08-19' },
  planSpendPaydayFunding,
});
const render = (periodId, planSpendPaydayFunding) =>
  f.payPeriodTimelineHtml(adviceFor(periodId, planSpendPaydayFunding), periodId, null, null, '', null);

let checks = 0;
function check(label, run) { run(); checks++; console.log('  PASS  ' + label); }

check('a period whose payday has a contribution shows the earmark with named allocations', () => {
  const html = render('future:2026-10-23', schedule('ready'));
  assert.match(html, /data-plan-spend-earmark="2026-10-23"/);
  assert.match(html, /Set aside \$1,200\.00 for future costs/);
  assert.match(html, /Fusion season — household \(October\)/);
  assert.doesNotMatch(html, /Forecast earmark for named planned costs on this payday/);
  assert.doesNotMatch(html, /Balance After Deductions/);
});

check('the earmark renders after the waterfall, not inside it', () => {
  const html = render('future:2026-10-23', schedule('ready'));
  const waterfallAt = html.indexOf('data-waterfall');
  const earmarkAt = html.indexOf('data-plan-spend-earmark');
  assert.ok(waterfallAt >= 0 && earmarkAt > waterfallAt, 'earmark follows the waterfall');
});

check('a period with zero contribution shows no earmark', () => {
  const html = render('future:2026-11-06', schedule('ready'));
  assert.doesNotMatch(html, /data-plan-spend-earmark/);
});

check('a period with no matching payday shows no earmark', () => {
  const html = render('future:2026-10-09', schedule('ready'));
  assert.doesNotMatch(html, /data-plan-spend-earmark/);
});

check('no earmark when the schedule is unavailable', () => {
  const html = render('future:2026-10-23', schedule('unavailable'));
  assert.doesNotMatch(html, /data-plan-spend-earmark/);
});

check('a funding-gap schedule still shows valid payday earmarks', () => {
  const html = render('future:2026-10-23', schedule('funding-gap'));
  assert.match(html, /data-plan-spend-earmark="2026-10-23"/);
  assert.match(html, /Set aside \$1,200\.00 for future costs/);
});

check('no earmark when Forecast publishes no schedule', () => {
  const html = render('future:2026-10-23', null);
  assert.doesNotMatch(html, /data-plan-spend-earmark/);
});

check('selected Budget funding suppresses the old cap-basis banner, including unavailable', () => {
  for (const status of ['ready', 'unavailable']) {
    const selectedPeriod = Object.assign({}, periods[1], { plannedCostFunding: { status } });
    assert.equal(f.budgetPlanSpendEarmarkHtml(adviceFor(selectedPeriod.id, schedule('ready')), selectedPeriod), '');
  }
});

console.log(`\n${checks} checks passed.`);
