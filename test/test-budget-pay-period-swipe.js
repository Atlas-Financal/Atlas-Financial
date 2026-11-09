'use strict';
/* Budget pay-period navigation is presentation only. Synthetic rows prove
 * selection, one-step gesture/control movement, bounds, trust preservation,
 * and direct-row rendering without pinning live household cents.
 *
 * `node test/test-budget-pay-period-swipe.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (condition, label, detail = '') => {
  if (!condition) failures++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const planSource = sourceText(fs.readFileSync(path.join(__dirname, '..', 'public', 'plan.js'), 'utf8'));
const polishSource = sourceText(fs.readFileSync(path.join(__dirname, '..', 'public', 'budget-polish.js'), 'utf8'));
const grab = (name) => {
  const re = new RegExp(`^function ${name}\\([\\s\\S]*?\\n\\}`, 'm');
  const match = re.exec(planSource);
  if (!match) throw new Error(`missing ${name}`);
  return match[0];
};

const selectedRows = [];
const source = [
  grab('payPeriodSelection'),
  grab('payPeriodMoveSelection'),
  grab('payPeriodRangeLabel'),
  grab('payPeriodStatusLabel'),
  grab('payPeriodSwipeStep'),
  grab('payPeriodCloseMonth'),
  grab('payPeriodMonths'),
  grab('payPeriodNavigatorHtml'),
  grab('budgetPlanSpendEarmarkHtml'),
  grab('payPeriodTimelineHtml'),
].join('\n');
const composer = vm.runInNewContext(`${source}\n({
  payPeriodSelection, payPeriodMoveSelection, payPeriodSwipeStep,
  payPeriodNavigatorHtml, payPeriodTimelineHtml
});`, {
  escapeHtml: require('./app-escape-html'),
  fmtDate: value => value,
  periodBillLine: row => `<i>${row && row.id}</i>`,
  liveCurrentBalanceHtml: () => '<div data-live-current-balance>live</div>',
  calendarWaterfallHtml: period => {
    selectedRows.push(period);
    return `<section data-rendered-row="${period.id}" data-bad="${period.predictedEndingBalance}">${JSON.stringify(period)}</section>`;
  },
});

const row = (id, timelineRole, start, bad, extra = {}) => Object.assign({
  id,
  timelineRole,
  evidenceState: timelineRole === 'past' ? 'historical'
    : timelineRole === 'current' ? 'live' : 'projected',
  start,
  end: start,
  rangeLabel: start,
  income: [],
  bills: [],
  householdBudget: [],
  predictedEndingBalance: bad,
}, extra);
const past0 = row('past:0', 'past', '2031-01-01', 111, {
  income: [{ id: 'salary', status: 'received', actual: 901 }],
  bills: [{ id: 'rent', status: 'PAID', amount: 302 }],
  householdBudget: [{ id: 'food', spent: 104 }],
});
const past1 = row('past:1', 'past', '2031-01-15', 222);
const current = row('this-pay-period', 'current', '2031-01-29', 333, {
  liveCurrentBalance: 777,
  income: [{ id: 'salary', status: 'received', amount: 1200 }],
  bills: [{ id: 'rent', status: 'PAID', amount: 400 }],
  householdBudget: [{ id: 'food', spent: 50, remaining: 150 }],
});
const next = row('next-pay-period', 'next', '2031-02-12', 444, {
  income: [{ id: 'salary', status: 'planned', amount: 1200 }],
  bills: [{ id: 'rent', status: 'planned', amount: 400 }],
  householdBudget: [{ id: 'food', planned: 200, projected: true }],
});
const future = row('future:2031-02-26', 'future', '2031-02-26', 555, {
  income: [{ id: 'salary', status: 'planned', amount: 1200 }],
  bills: [{ id: 'rent', status: 'planned', amount: 400 }],
  householdBudget: [{ id: 'food', planned: 200, projected: true }],
});
const advice = {
  payPeriodViews: [past0, past1, current, next, future],
  defaultView: {
    asOf: '2031-01-30',
    calendarPeriods: [current, next],
    liveCurrentBalance: current.liveCurrentBalance,
    undatedBills: [],
  },
};
const id = selection => selection.period && selection.period.id;

console.log('=== selection and one-step navigation ===');
const initial = composer.payPeriodSelection(advice, null);
ok(id(initial) === current.id, '1. initial load selects the Forecast current row');
ok(initial.period === advice.defaultView.calendarPeriods[0],
  '2. current row is the unchanged incumbent calendar-period object');

const left = composer.payPeriodSwipeStep({ x: 200, y: 20 }, { x: 90, y: 25 });
const afterLeft = composer.payPeriodMoveSelection(advice, id(initial), left);
ok(left === 1 && id(afterLeft) === next.id,
  '3. one left swipe selects exactly the next Forecast row');
const afterSecondLeft = composer.payPeriodMoveSelection(advice, id(afterLeft), left);
ok(id(afterSecondLeft) === future.id,
  '4. a second left swipe selects the following Forecast row');
const right = composer.payPeriodSwipeStep({ x: 90, y: 25 }, { x: 200, y: 20 });
const afterRight = composer.payPeriodMoveSelection(advice, id(afterSecondLeft), right);
ok(right === -1 && id(afterRight) === next.id,
  '5. one right swipe returns exactly one Forecast row');
ok(id(composer.payPeriodMoveSelection(advice, id(initial), 1)) === id(afterLeft)
    && id(composer.payPeriodMoveSelection(advice, id(afterLeft), 1)) === id(afterSecondLeft)
    && id(composer.payPeriodMoveSelection(advice, id(afterSecondLeft), -1)) === id(afterRight),
  '6. Previous/Next steps select the same rows as swipe');

console.log('\n=== bounds, trust, and exact-row rendering ===');
const atStart = composer.payPeriodMoveSelection(advice, past0.id, -1);
const atEnd = composer.payPeriodMoveSelection(advice, future.id, 1);
const startNav = composer.payPeriodNavigatorHtml(atStart);
const endNav = composer.payPeriodNavigatorHtml(atEnd);
ok(id(atStart) === past0.id && id(atEnd) === future.id
    && /data-wheel-index="0"[\s\S]*?aria-current="true"/.test(startNav)
    && /data-wheel-index="4"[\s\S]*?aria-current="true"/.test(endNav),
  '7. bounds keep their selected items and never wrap');

const futureHtml = composer.payPeriodTimelineHtml(advice, future.id, {}, {}, '', {});
ok(!/data-live-current-balance/.test(futureHtml),
  '8. a future row has no live Current Balance');
ok(!/"status":"PAID"|"spent":/.test(futureHtml),
  '9. a future row has no invented PAID or Spent state');

const pastHtml = composer.payPeriodTimelineHtml(advice, past0.id, {}, {}, '', {});
ok(/"evidenceState":"historical"/.test(pastHtml)
    && /"status":"received"/.test(pastHtml)
    && /"status":"PAID"/.test(pastHtml)
    && /"spent":104/.test(pastHtml),
  '10. a past row keeps Forecast historical evidence');
ok(/data-rendered-row="future:2031-02-26" data-bad="555"/.test(futureHtml)
    && selectedRows[selectedRows.length - 2] === future,
  '11. the displayed BAD and body come directly from the selected row');
const currentHtml = composer.payPeriodTimelineHtml(advice, current.id, {}, {}, '', {});
ok(/data-calendar-waterfalls data-household-as-of="2031-01-30"/.test(currentHtml)
    && /data-household-as-of="2031-01-30"/.test(futureHtml)
    && !/data-household-as-of="2031-02-26"/.test(futureHtml)
    && /function householdAsOf[\s\S]*?getAttribute\('data-household-as-of'\)/.test(polishSource),
  '11a. every selected row supplies the authoritative as-of anchor Budget bill chrome consumes');

console.log('\n=== authority and accessible input contracts ===');
ok(!/income\s*[−-]\s*[^\n]*bills/i.test(planSource),
  '12. page source has no Income minus Bills minus Household Budget arithmetic');
// AMANDA SLICE 3: the Budget Month view legitimately reprints
// Forecast.baselineTrajectory months[]. This check guards the pay-period
// swipe composer functions only — they must not depend on Road Ahead.
ok(!/baselineTrajectory|roadAhead|stage1|stage2|stage3/.test(source),
  '13. pay-period swipe source does not read Road Ahead results');
ok(composer.payPeriodSwipeStep({ x: 50, y: 10 }, { x: 57, y: 150 }) === 0
    && composer.payPeriodSwipeStep({ x: 50, y: 10 }, { x: 92, y: 25 }) === 0,
  '14. vertical scroll and weak horizontal intent do not change period');
ok(composer.payPeriodSwipeStep({ x: 200, y: 20, t: 0 }, { x: 100, y: 24, t: 0 }, 144) === 1
    && composer.payPeriodSwipeStep({ x: 100, y: 24, t: 0 }, { x: 200, y: 20, t: 0 }, 144) === -1,
  '14a. a normal one-slot drag changes the measured wheel by exactly one item');
ok(composer.payPeriodSwipeStep({ x: 400, y: 0, t: 0 }, { x: 83, y: 0, t: 30 }, 144) === 2,
  '14b. a drag across two slot centers snaps to two and a fast release does not add another');
ok(composer.payPeriodSwipeStep({ x: 200, y: 10, t: 100 }, { x: 172, y: 12, t: 140 }, 144) === 1
    && composer.payPeriodSwipeStep({ x: 200, y: 10, t: 100 }, { x: 172, y: 12, t: 500 }, 144) === 0
    && composer.payPeriodSwipeStep({ x: 200, y: 10, t: 0 }, { x: 157, y: 12, t: 0 }, 144) === 0
    && composer.payPeriodSwipeStep({ x: 50, y: 10, t: 0 }, { x: 150, y: 190, t: 0 }, 144) === 0,
  '14c. a short flick moves one, a slow or sub-half drag stays, and vertical intent stays');
ok(/addEventListener\('keydown'/.test(planSource)
    && /ArrowLeft/.test(planSource) && /ArrowRight/.test(planSource)
    && /data-wheel-index/.test(planSource)
    && /aria-label="Pay-period navigation/.test(planSource),
  '15. desktop keyboard and named button navigation are wired without touch');
ok(!/value="next-period"|value="past:/.test(
    (/function operatingSurfaceHtml\([\s\S]*?\n\}/m.exec(planSource) || [''])[0]),
  'legacy current/next/past selector choices are absent from the household surface');

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
