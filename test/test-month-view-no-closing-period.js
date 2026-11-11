'use strict';
/* Audit finding 8, part 1: a Month-view month in which no pay period closes
 * has no funding decomposition to sum, so it never prints a confident $0.00
 * for income, bills, required debt or household spending. It reads Unknown
 * with the plain reason. Months where periods do close are unchanged.
 *
 * Invented world: biweekly 1,400 payroll anchored Fri 2026-10-02 (paydays
 * Oct 2, 16, 30, Nov 13, 27, Dec 11, 25), rent 900 on the 1st, one grocery
 * budget. Hand-worked from those inputs:
 *   as-of Oct 14: the pay periods closing in October that are still ahead are
 *     funded by one 1,400 payday -> October Total income $1,400.00; November
 *     closes two periods (Oct 30 and Nov 13 paydays) -> $2,800.00; December
 *     closes two (Nov 27 and Dec 11) -> $2,800.00.
 *   as-of Oct 30 (a payday falls on the 30th): no pay period closes in
 *     October any more, but the month holds a payday. October income, bills,
 *     required debt and household spending must be Unknown, never $0.00.
 *   A monthly-paid household has no Seaspan pay periods at all: every month is
 *     Unknown rather than a confident $0.00.
 *
 * Page path: Forecast.baselineTrajectory -> plan.js budgetMonthViewHtml.
 * `node test/test-month-view-no-closing-period.js`
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' - ' + detail : ''}`);
};
const planSource = sourceText(fs.readFileSync(path.join(__dirname, '../public/plan.js'), 'utf8'));
const context = vm.createContext({ escapeHtml: require('./app-escape-html'), Forecast: F,
  money2: n => (n < 0 ? '−$' : '$') + Math.abs(Number(n)).toLocaleString('en-CA',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  fmtDateLong: iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-CA', { day: 'numeric', month: 'long' }) });
vm.runInContext(planSource, context);
const evalInPage = js => vm.runInContext(js, context);

const plan = (asOf, income) => ({
  defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' }, windowDays: 200,
  opening: { asOf }, startingCash: { breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 5000, class: 'spendable' }] },
  budget: { categories: [{ id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedWeekly: 100 }] },
  obligations: [], commitments: [],
  bills: [{ id: 'rent', label: 'Rent', frequency: 'monthly', day: 1, amount: 900, confidence: 'confirmed', payingAccount: 'chequing-a' }],
  income: [income],
});
const biweekly = { id: 'payroll', label: 'Invented pay', frequency: 'biweekly', anchor: '2026-10-02', amount: 1400, confidence: 'confirmed' };
const monthly = { id: 'payroll', label: 'Invented pay', frequency: 'monthly', day: 15, amount: 1400, confidence: 'confirmed' };

function monthHtml(asOf, income, month) {
  const p = plan(asOf, income);
  evalInPage("budgetGranularity = 'month'; budgetSelectedMonth = '" + month + "'; budgetTrajectoryCache = null; budgetTrajectoryCacheKey = null;");
  const html = context.budgetMonthViewHtml({ plan: p, debts: [], asOf, weekly: 100, periods: null, revolvingExtra: null, liveOverlay: null });
  evalInPage("budgetGranularity = 'pay-period'; budgetSelectedMonth = null;");
  return html;
}
// The one component row a household reads: its label, its state and its text.
function row(html, label) {
  const m = new RegExp('<div class="budget-month-row( unavailable)?"[^>]*><span class="budget-month-label">' + label
    + '</span><span class="budget-month-(?:amount|unavailable)">([^<]*(?:<[^>]*>[^<]*)*?)</span></div>').exec(html);
  return m ? { unavailable: !!m[1], text: m[2].replace(/<[^>]*>/g, '').trim() } : null;
}
const LABELS = ['Total income', 'Regular household spending', 'Bills', 'Required debt payments'];

/* Controls: months in which periods close are unchanged. */
{
  const oct = monthHtml('2026-10-14', biweekly, '2026-10');
  const r = row(oct, 'Total income');
  ok(r && !r.unavailable && /\$1,400\.00/.test(r.text), 'control (as-of Oct 14): October Total income stays $1,400.00', r && r.text);
  const nov = row(monthHtml('2026-10-14', biweekly, '2026-11'), 'Total income');
  ok(nov && !nov.unavailable && /\$2,800\.00/.test(nov.text), 'control: November (two closing periods) stays $2,800.00', nov && nov.text);
  const dec = row(monthHtml('2026-10-14', biweekly, '2026-12'), 'Total income');
  ok(dec && !dec.unavailable && /\$2,800\.00/.test(dec.text), 'control: December stays $2,800.00', dec && dec.text);
}

/* The defect: a payday on the 30th, no pay period closing in October. */
{
  const traj = F.baselineTrajectory(plan('2026-10-30', biweekly), [], '2026-10-30', { weeklyVariable: 100,
    periods: { periods: { ytd: { label: 'YTD', months: 1, spending: [{ label: 'Groceries', total: 50000 }] } } } });
  const oct = (traj.months || []).find(m => m.month === '2026-10');
  ok(oct && oct.income && oct.income.amount === 1400, 'a payday falls inside October (calendar income 1,400)');
  ok(oct && oct.stage1 && oct.stage1.status === 'unavailable' && /No Seaspan pay period closes in this month/.test(oct.stage1.reason || ''),
    'Forecast publishes Unknown with the plain reason for the month with no closing period', oct && oct.stage1 && oct.stage1.status);
  const html = monthHtml('2026-10-30', biweekly, '2026-10');
  for (const label of LABELS) {
    const r = row(html, label);
    ok(r && r.unavailable && /No Seaspan pay period closes in this month/.test(r.text) && /Not \$0/.test(r.text) && !/\$0\.00/.test(r.text),
      `page Month view: ${label} is Unknown with the reason, not $0.00`, r && r.text);
  }
}

/* A monthly-paid household has no Seaspan pay periods: Unknown, not $0.00. */
{
  const html = monthHtml('2026-10-14', monthly, '2026-11');
  const r = row(html, 'Total income');
  ok(r && r.unavailable && !/\$0\.00/.test(r.text), 'monthly-paid household: Month Total income is Unknown, not $0.00', r && r.text);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
