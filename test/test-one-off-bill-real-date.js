'use strict';
/* A one-off bill that stands beside a recurring bill is counted in the pay
 * period that holds its real date. `node test/test-one-off-bill-real-date.js`
 *
 * Before this fix, a once row whose day of month was earlier than its
 * recurring sibling's day was moved back a month for the Plan bills list.
 * That moved date then decided inclusion, so the one-off dropped off the
 * current period (Plan over-optimistic, Talk and the cash walk still owed it)
 * or was printed in the wrong period.
 *
 * Every household below is invented. Expected figures are worked out here by
 * hand from the inputs, not by asking Forecast; the page is the real Budget
 * renderer (app.js + budget-surface.js + plan.js) on the served packet.
 *
 * Pay periods (biweekly payday anchor Sep 11, 2026; as-of Sep 12):
 *   this period Sep 11 – Sep 24, next period Sep 25 – Oct 8.
 * Each period receives 5,000 pay. No budget categories, so
 *   Balance After Deductions = 5,000 - bills in that period.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${msg}${!cond && detail ? `  — ${detail}` : ''}`);
  if (!cond) failures++;
};
const money = n => '$' + n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

function stubEl() {
  return { innerHTML: '', textContent: '', hidden: false, value: '',
    style: { setProperty() {}, getPropertyValue() { return ''; } }, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, hasAttribute() { return false; },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild() {}, insertAdjacentHTML() {}, closest() { return null; }, children: [] };
}

// The Budget page scripts in index.html order (same harness as
// test-budget-surface.js).
function renderBudget(served) {
  const els = new Map();
  const context = vm.createContext({ Forecast: F, console, addEventListener() {}, setTimeout, clearTimeout,
    document: { addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
      getElementById(id) { if (!els.has(id)) els.set(id, stubEl()); return els.get(id); },
      documentElement: { dataset: {}, style: {} }, createElement: stubEl, createElementNS: stubEl, body: stubEl() },
    window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  context.window = Object.assign(context, { matchMedia() { return { matches: false, addEventListener() {} }; } });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8'), context);
  vm.runInContext('App.boot = () => {}; App.once = () => {}; App.register = () => {};', context);
  for (const f of ['forecast-chequing.js', 'balance-history.js', 'bill-detail.js', 'savings-inventory.js',
    'budget-surface.js', 'plan.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), context);
  }
  vm.runInContext('forecastChart = () => {}; renderCalendar = () => {};', context);
  context.served = served;
  vm.runInContext("Object.defineProperty(App, 'data', { get: () => served, configurable: true });", context);
  vm.runInContext('Object.assign(state, served.plan.defaults, { debts: served.debts }); renderPlan(served, null, null);', context);
  return els.get('operating-surface-body').innerHTML;
}

const AS_OF = '2026-09-12';
function served(recurring, oneOff) {
  return {
    meta: { asOf: AS_OF, title: 'Invented one-off household' },
    accounts: [], revolvingExtra: [], debts: [],
    plan: {
      windowDays: 91,
      opening: { asOf: AS_OF },
      startingCash: { breakdown: [{ id: 'chequing-a', label: 'Invented bills account', value: 5000 }] },
      defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
      income: [{ id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
        anchor: '2026-09-11', amount: 5000, confidence: 'confirmed' }],
      bills: [
        Object.assign({ id: 'phone', label: 'Invented phone', frequency: 'monthly',
          amount: 160, confidence: 'confirmed', payingAccount: 'chequing-a' }, recurring),
        Object.assign({ id: 'phone-one-off', label: 'Invented phone one-off', frequency: 'once',
          amount: 283.94, confidence: 'confirmed', payingAccount: 'chequing-a' }, oneOff),
        { id: 'hydro', label: 'Invented hydro', frequency: 'monthly', day: 18,
          amount: 200, confidence: 'confirmed', payingAccount: 'chequing-a' },
      ],
      obligations: [], budget: { categories: [] }, commitments: [],
    },
  };
}

// The active period's printed terms, and the hidden per-period timeline.
function term(html, name) {
  const m = new RegExp(`data-bad-term="${name}"[^>]*>[\\s\\S]*?(\\$[0-9,]+\\.[0-9]{2})`).exec(html);
  return m ? m[1] : null;
}
function timelineBad(html, start) {
  const m = new RegExp(`data-bad-timeline-start="${start}"[^>]*>[\\s\\S]*?data-bad-term-amount>([^<]*)<`).exec(html);
  return m ? m[1] : null;
}
function billLine(html, label) {
  const m = new RegExp(`${label} · ([A-Z][a-z]{2} \\d{1,2}) · `).exec(text(html));
  return m ? m[1] : null;
}

console.log('=== 1. one-off dated the day before its recurring day is in this period ===');
{
  // Recurring phone day 15, first cadence occurrence Oct 15. One-off Sep 14.
  // This period's bills: one-off 283.94 (Sep 14) + hydro 200 (Sep 18).
  const bills = 283.94 + 200;
  const html = renderBudget(served({ day: 15, firstDue: '2026-10-15' }, { date: '2026-09-14' }));
  ok(term(html, 'assignedBills') === money(bills), `assigned bills are ${money(bills)}`, term(html, 'assignedBills'));
  ok(term(html, 'balanceAfterDeductions') === money(5000 - bills),
    `Balance After Deductions is ${money(5000 - bills)}`, term(html, 'balanceAfterDeductions'));
  ok(billLine(html, 'Invented phone one-off') === 'Sep 14', 'the one-off row is printed on its real date, Sep 14',
    billLine(html, 'Invented phone one-off'));
  ok(timelineBad(html, '2026-09-25') === money(5000), 'next period carries no copy of it');
}

console.log('\n=== 2. one-off dated next period, before the recurring day, stays in next period ===');
{
  // Recurring day 20, first cadence occurrence Nov 20 (Oct 20 is skipped, so
  // the Oct 5 one-off is October's). This period: hydro 200 only. Next
  // period Sep 25 – Oct 8: one-off 283.94; Oct 18 hydro is after Oct 8.
  const html = renderBudget(served({ day: 20, firstDue: '2026-11-20' }, { date: '2026-10-05' }));
  ok(term(html, 'assignedBills') === money(200), 'this period is billed hydro only', term(html, 'assignedBills'));
  ok(term(html, 'balanceAfterDeductions') === money(4800), 'this period Balance After Deductions is $4,800.00',
    term(html, 'balanceAfterDeductions'));
  ok(timelineBad(html, '2026-09-25') === money(5000 - 283.94),
    `next period Balance After Deductions is ${money(5000 - 283.94)}`, timelineBad(html, '2026-09-25'));
  ok(billLine(html, 'Invented phone one-off') === null, 'the one-off is not printed in this period');
}

console.log('\n=== 3. a one-off that stands in for the skipped prior month: printed on that due, counted by real date ===');
{
  // Recurring day 20, first cadence occurrence Oct 20 (it still emits
  // October and skips September). The Oct 5 one-off therefore stands in
  // for Sep 20. row.date is Oct 5; Sep 20 is the printed label only.
  const data = served({ day: 20, firstDue: '2026-10-20' }, { date: '2026-10-05' });
  const html = renderBudget(data);
  const next = (F.recommend(data.plan, AS_OF, {}).defaultView.billSections || [])
    .find(sec => sec.id === 'next-pay-period');
  const row = ((next && next.rows) || []).find(r => r.id === 'phone-one-off');
  ok(row && row.date === '2026-10-05' && row.scheduledDue === '2026-09-20',
    'the row date is the real Oct 5; the stood-in Sep 20 due is its printed label only',
    row && (row.date + ' / ' + row.scheduledDue));
  ok(term(html, 'assignedBills') === money(200), 'this period is still billed hydro only', term(html, 'assignedBills'));
  ok(timelineBad(html, '2026-09-25') === money(5000 - 283.94),
    `next period Balance After Deductions is ${money(5000 - 283.94)}`, timelineBad(html, '2026-09-25'));
}

console.log('\n=== 4. an explicit scheduledDate names the occurrence; inclusion still uses the real date ===');
{
  const html = renderBudget(served({ day: 15, firstDue: '2026-10-15' },
    { date: '2026-09-14', scheduledDate: '2026-08-15' }));
  ok(term(html, 'assignedBills') === money(283.94 + 200), 'this period still counts the one-off',
    term(html, 'assignedBills'));
  ok(billLine(html, 'Invented phone one-off') === 'Aug 15', 'the row shows the named scheduled due, Aug 15',
    billLine(html, 'Invented phone one-off'));
}

console.log('\n=== 5. an already-paid one-off in the next period follows the future-period rule ===');
{
  // As-of Sep 24 (last day of this period). Recurring day 20, first due
  // Oct 20; the Oct 5 one-off stands in for Sep 20 and is already
  // represented. It sits in the next period by its real date (Oct 5, after
  // as-of), so like any future occurrence it stays planned in that period:
  // next-period BAD 5,000 - 283.94. It must not read PAID with $0 left.
  const data = served({ day: 20, firstDue: '2026-10-20' }, { date: '2026-10-05' });
  data.meta.asOf = data.plan.opening.asOf = '2026-09-24';
  data.plan.opening.representedEvents = [{ id: 'phone-one-off', date: '2026-10-05' }];
  const html = renderBudget(data);
  ok(timelineBad(html, '2026-09-25') === money(5000 - 283.94),
    `next period Balance After Deductions is ${money(5000 - 283.94)}`, timelineBad(html, '2026-09-25'));
  const view = F.recommend(data.plan, '2026-09-24', {}).defaultView;
  const next = (view.billSections || []).find(sec => sec.id === 'next-pay-period');
  const row = ((next && next.rows) || []).find(r => r.id === 'phone-one-off');
  ok(row && row.status !== 'PAID' && Math.abs(row.remaining - 283.94) < 0.005,
    'the next-period row is planned with 283.94 remaining, not PAID', row && row.status);
}

console.log('\n=== 6. the Plan agrees with Talk\'s remaining-bills source ===');
{
  const data = served({ day: 15, firstDue: '2026-10-15' }, { date: '2026-09-14' });
  const states = F.currentPeriodObligationStates(data.plan, AS_OF, {});
  const listed = ((states && states.bills) || []).some(r => r && r.id === 'phone-one-off'
    && r.date === '2026-09-14' && Math.abs(r.remaining - 283.94) < 0.005);
  const html = renderBudget(data);
  ok(listed && billLine(html, 'Invented phone one-off') === 'Sep 14',
    'both the remaining-bills source and the Budget page list the one-off in this period');
}

console.log('\n=== 7. a paid one-off after a recorded payday opening is deducted whatever its scheduled label ===');
{
  // Payday Sep 11 recorded as a morning snapshot (opening 5,000, before
  // that period's bills). Live opening advanced to Sep 16 (priorAsOf Sep
  // 11). The one-off is dated Sep 16 and already paid; its scheduledDate
  // names Aug 15. The Sep 16 payment left cash after the Sep 11 snapshot,
  // so the period still deducts it: Assigned bills 283.94 + hydro 200.
  // The same household without the label is the control.
  const build = scheduledDate => {
    const data = served({ day: 15, firstDue: '2026-10-15' },
      Object.assign({ date: '2026-09-16' }, scheduledDate ? { scheduledDate } : {}));
    data.meta.asOf = '2026-09-16';
    data.plan.opening = { asOf: '2026-09-16', priorAsOf: '2026-09-11',
      paydaySnapshot: { periodStart: '2026-09-11', asOf: '2026-09-11', opening: 5000 },
      representedEvents: [{ id: 'phone-one-off', date: '2026-09-16' }] };
    return data;
  };
  const labelled = renderBudget(build('2026-08-15'));
  const control = renderBudget(build(null));
  ok(term(labelled, 'assignedBills') === money(283.94 + 200),
    `Assigned bills are ${money(283.94 + 200)} with the Aug 15 label`, term(labelled, 'assignedBills'));
  ok(term(labelled, 'assignedBills') === term(control, 'assignedBills')
    && term(labelled, 'balanceAfterDeductions') === term(control, 'balanceAfterDeductions'),
    'the label moves neither Assigned bills nor Balance After Deductions',
    term(labelled, 'balanceAfterDeductions') + ' vs ' + term(control, 'balanceAfterDeductions'));
}

console.log('\n=== 8. Budget progress counts a paid one-off by its real date, not its printed due ===');
{
  // As-of Oct 1, period Sep 25 – Oct 8. Recurring day 28 first due Sep 28
  // (it emits September and skips August), so a Sep 26 one-off stands in
  // for Aug 28 and prints Aug 28. It was paid 283.94 on Sep 26, inside this
  // period, so this period's bills actual includes 283.94 (not Unknown).
  const data = served({ day: 28, firstDue: '2026-09-28' }, { date: '2026-09-26' });
  data.plan.bills = data.plan.bills.filter(b => b.id !== 'hydro');
  const asOf = '2026-10-01';
  data.plan.opening.asOf = asOf;
  const advice = F.recommend(data.plan, asOf, {
    representedEvents: [{ id: 'phone-one-off', date: '2026-09-26' }],
    currentPeriodActuals: { schema: 'atlas-current-period-actuals/v1', observationAsOf: asOf,
      coverageStart: '2026-09-01', coverageThrough: asOf, transactionCoverage: 'complete', pendingCoverage: 'complete',
      representedActuals: [{ id: 'phone-one-off', date: '2026-09-26', actual: 283.94, postedOn: '2026-09-26' }],
      transactions: [] },
  });
  const period = (advice.payPeriodViews || []).find(p => p.start === '2026-09-25');
  const actual = period && period.budgetProgress && period.budgetProgress.bills && period.budgetProgress.bills.actual;
  ok(actual && Math.abs(actual.amount - 283.94) < 0.005, 'this period\'s bills actual includes the paid 283.94',
    actual && String(actual.amount));
}

console.log('\n=== 9. Budget progress: an unpaid one-off due after as-of is known $0 paid, not Unknown ===');
{
  // As-of Oct 1, period Sep 25 - Oct 8. Recurring day 28 first due Oct 28
  // (emits October, skips September): an Oct 5 one-off stands in for
  // Sep 28 and prints Sep 28. It is unpaid and its real date is after
  // as-of, so nothing should have been paid yet: bills actual is a known
  // $0, exactly as for the same one-off without a recurring sibling.
  const progress = (bills) => {
    const data = served({ day: 28, firstDue: '2026-10-28' }, { date: '2026-10-05' });
    data.plan.bills = bills(data.plan.bills);
    const asOf = '2026-10-01';
    data.plan.opening.asOf = asOf;
    const advice = F.recommend(data.plan, asOf, {
      currentPeriodActuals: { schema: 'atlas-current-period-actuals/v1', observationAsOf: asOf,
        coverageStart: '2026-09-01', coverageThrough: asOf, transactionCoverage: 'complete', pendingCoverage: 'complete',
        representedActuals: [], transactions: [] },
    });
    const period = (advice.payPeriodViews || []).find(p => p.start === '2026-09-25');
    return period && period.budgetProgress && period.budgetProgress.bills && period.budgetProgress.bills.actual;
  };
  const sibling = progress(rows => rows.filter(b => b.id !== 'hydro'));
  const alone = progress(rows => rows.filter(b => b.id === 'phone-one-off')
    .map(b => Object.assign({}, b, { id: 'standalone-one-off' })));
  ok(sibling && sibling.amount === 0 && alone && alone.amount === 0
    && sibling.completeness === alone.completeness,
    'bills actual is a known $0 with or without the recurring sibling',
    JSON.stringify(sibling && { amount: sibling.amount, completeness: sibling.completeness }));
}

console.log('\n=== 10. a labelled one-off card minimum with qualified sent evidence keeps its paid progress ===');
{
  // Invented card ledger (card-backfill fixture). Recurring card minimum day
  // 9, first due Nov 9; a once October minimum dated Oct 6 for 100, sent
  // and posted Oct 5 from the bills account. The scheduled label must not
  // change the period's bills actual: labelled and unlabelled agree, and
  // the 100 sent is counted.
  const Live = require('../scripts/live-plan');
  const source = require('./fixtures/card-backfill-data');
  const progress = label => {
    const x = source('triangle', 'triangle');
    x.asOf = '2026-10-05';
    x.data.meta.asOf = x.data.plan.opening.asOf = '2026-10-02';
    x.data.plan.windowDays = 28;
    x.data.plan.income[0].anchor = '2026-10-02';
    x.data.plan.startingCash.breakdown[1].value = 100;
    x.data.plan.obligations[0] = { id: 'triangle', debtId: 'triangle', effect: 'payment',
      label: 'Invented card minimum', frequency: 'monthly', day: 9, firstDue: '2026-11-09',
      amount: 88.88, confidence: 'estimated', payingAccount: 'chequing-a' };
    x.data.plan.obligations.push(Object.assign({ id: 'triangle-oct', debtId: 'triangle', effect: 'payment',
      label: 'Invented card minimum (October)', frequency: 'once', date: '2026-10-06',
      amount: 100, confidence: 'confirmed', payingAccount: 'chequing-a',
      sentPayments: [{ scheduledDate: '2026-10-06', confirmed: true, intent: 'minimum',
        debitId: 'invented-bank-debit', postedOn: '2026-10-05', amount: 100, currency: 'cad',
        fundingAccountId: 'chequing-a', pending: false }] }, label ? { scheduledDate: label } : {}));
    x.payload.fetchedAt = x.asOf + 'T18:00:00Z';
    x.payload.transactionWindow = { startDate: '2026-10-02', endDate: x.asOf,
      complete: true, hasMore: false, truncated: false };
    x.payload.transactions = [{ id: 94001, account_id: 3001, date: x.asOf, amount: 100, currency: 'cad',
      payee: 'Invented retailer', category_name: 'Credit card payment', is_pending: false }];
    x.payload.accounts.forEach(a => { a.updated_at = a.balance_last_update = x.asOf + 'T17:00:00Z'; });
    x.payload.accounts[0].balance = 400; x.payload.accounts[1].balance = 64.30; x.payload.accounts[3].balance = 400;
    const result = Live.fromObservation(x);
    const advice = F.recommend(result.data.plan, x.asOf,
      { debts: result.data.debts, currentPeriodActuals: result.data.liveOverlay.currentPeriodActuals });
    const period = advice.payPeriodViews.find(row => row.start <= x.asOf && row.end >= x.asOf);
    const row = (period.bills || []).find(r => r.id === 'triangle-oct');
    return { actual: period.budgetProgress.bills.actual, row };
  };
  const labelled = progress('2026-09-09');
  const control = progress(null);
  ok(labelled.row && labelled.row.date === '2026-10-06' && labelled.row.scheduledDue === '2026-09-09',
    'the labelled row keeps its real Oct 6 date; Sep 9 is its printed label');
  ok(labelled.actual.amount === 100 && control.actual.amount === 100
    && labelled.actual.completeness === control.actual.completeness,
    'bills actual counts the 100 sent, labelled or not',
    JSON.stringify({ labelled: labelled.actual.amount, control: control.actual.amount }));
}

console.log('\n=== 11. only the bill-row printers read scheduledDue ===');
{
  // Guard: row.date is the one occurrence authority. scheduledDue may be
  // set in calendarBillRowFromEvent and read only by the printers (and the
  // printed-list de-duplication in calendarBillSections).
  const ALLOWED = {
    'public/forecast.js': ['calendarBillRowFromEvent', 'calendarBillSections'],
    'public/plan.js': ['glanceLineLabel', 'budgetBillBrowseRowHtml'],
    'public/bill-detail.js': ['html'],
  };
  const files = fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.js')).map(f => 'public/' + f)
    .concat(fs.readdirSync(path.join(ROOT, 'scripts')).filter(f => f.endsWith('.js')).map(f => 'scripts/' + f), ['server.js']);
  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    let at = src.indexOf('scheduledDue');
    while (at >= 0) {
      const before = src.slice(0, at);
      const fns = [...before.matchAll(/function\s+([A-Za-z0-9_$]+)\s*\(/g)];
      const name = fns.length ? fns[fns.length - 1][1] : '(top level)';
      if (!(ALLOWED[file] || []).includes(name)) offenders.push(`${file}:${before.split('\n').length} in ${name}`);
      at = src.indexOf('scheduledDue', at + 1);
    }
  }
  ok(offenders.length === 0, 'no other code reads scheduledDue', offenders.join(', '));
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
