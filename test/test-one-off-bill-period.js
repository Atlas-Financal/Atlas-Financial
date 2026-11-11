'use strict';
/* A one-off bill that stands beside a recurring bill is counted in the pay
 * period that holds its real date. `node test/test-one-off-bill-period.js`
 *
 * Before this fix, every once row filed beside a monthly bill (its id
 * extends the bill's id) was re-dated onto that bill's cadence day, moved
 * back a month when its own day was earlier. That moved date then decided
 * the pay period, so a genuine one-off dropped off its own period (Budget
 * over-optimistic while the cash walk and Talk still owed it) or was listed
 * in another one.
 *
 * Now a calendar bill row's `date` is always its real occurrence date. A
 * scheduled due that differs rides as `scheduledDue` and is only printed.
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

console.log('\n=== 4. a stand-in reserved on payday is counted in the period that starts that day ===');
{
  // Recurring day 10, first cadence occurrence Oct 10: it skips Sep 10. A
  // once row dated Sep 11 (payday, the first day of this period) stands in
  // for that Sep 10 occurrence. The cash leaves on Sep 11, so this period
  // carries it (283.94 + hydro 200) and prints the scheduled due, Sep 10.
  const data = served({ day: 10, firstDue: '2026-10-10' }, { date: '2026-09-11' });
  const html = renderBudget(data);
  ok(term(html, 'assignedBills') === money(283.94 + 200), 'this period counts the stand-in',
    term(html, 'assignedBills'));
  ok(billLine(html, 'Invented phone one-off') === 'Sep 10', 'the row prints the scheduled due, Sep 10',
    billLine(html, 'Invented phone one-off'));
  const sections = F.recommend(data.plan, AS_OF, {}).defaultView.billSections || [];
  const holders = sections.filter(sec => (sec.rows || []).some(r => r.id === 'phone-one-off'));
  const row = holders.length === 1 && holders[0].rows.find(r => r.id === 'phone-one-off');
  ok(holders.length === 1 && holders[0].start === '2026-09-11' && row.date === '2026-09-11'
    && row.scheduledDue === '2026-09-10',
    'one section holds it: the period starting Sep 11, row date Sep 11, scheduled due Sep 10',
    holders.map(sec => sec.start).join(','));
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

console.log('\n=== 7. a paid stand-in after a recorded payday opening is deducted whatever its printed due ===');
{
  // Payday Sep 11 recorded as a morning snapshot (opening 5,000, before
  // that period's bills). Live opening advanced to Sep 16 (priorAsOf Sep
  // 11). The once row is dated Sep 16 and already paid. Its recurring
  // sibling is day 10 with first occurrence Oct 10, so the row prints the
  // skipped Sep 10 due: a printed date BEFORE the recorded opening. The
  // Sep 16 payment left cash after the Sep 11 snapshot, so the period
  // still deducts it: Assigned bills 283.94 + hydro 200. The same
  // household with the row filed standalone (no printed due) is the control.
  const build = id => {
    const data = served({ day: 10, firstDue: '2026-10-10' }, { id, date: '2026-09-16' });
    data.meta.asOf = '2026-09-16';
    data.plan.opening = { asOf: '2026-09-16', priorAsOf: '2026-09-11',
      paydaySnapshot: { periodStart: '2026-09-11', asOf: '2026-09-11', opening: 5000 },
      representedEvents: [{ id, date: '2026-09-16' }] };
    return data;
  };
  const labelled = renderBudget(build('phone-one-off'));
  const control = renderBudget(build('standalone-one-off'));
  ok(billLine(labelled, 'Invented phone one-off') === 'Sep 10' && billLine(control, 'Invented phone one-off') === 'Sep 16',
    'the stand-in prints Sep 10; the standalone control prints Sep 16',
    billLine(labelled, 'Invented phone one-off') + ' / ' + billLine(control, 'Invented phone one-off'));
  ok(term(labelled, 'assignedBills') === money(283.94 + 200),
    `Assigned bills are ${money(283.94 + 200)} with the Sep 10 printed due`, term(labelled, 'assignedBills'));
  ok(term(labelled, 'assignedBills') === term(control, 'assignedBills')
    && term(labelled, 'balanceAfterDeductions') === term(control, 'balanceAfterDeductions'),
    'the printed due moves neither Assigned bills nor Balance After Deductions',
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

console.log('\n=== 10. a stood-in one-off card minimum with qualified sent evidence keeps its paid progress ===');
{
  // Invented card ledger (card-backfill fixture). Recurring card minimum day
  // 9, first due Nov 9 (it skips Oct 9). A once October minimum for 100 is
  // dated Oct 10, sent and posted Oct 5 from the bills account. Filed
  // beside the recurring minimum it stands in for Oct 9 and prints Oct 9;
  // filed standalone it prints Oct 10. The printed due must not change the
  // period's bills actual: both agree, and the 100 sent is counted.
  const Live = require('../scripts/live-plan');
  const source = require('./fixtures/card-backfill-data');
  const progress = id => {
    const x = source('triangle', 'triangle');
    x.asOf = '2026-10-05';
    x.data.meta.asOf = x.data.plan.opening.asOf = '2026-10-02';
    x.data.plan.windowDays = 28;
    x.data.plan.income[0].anchor = '2026-10-02';
    x.data.plan.startingCash.breakdown[1].value = 100;
    x.data.plan.obligations[0] = { id: 'triangle', debtId: 'triangle', effect: 'payment',
      label: 'Invented card minimum', frequency: 'monthly', day: 9, firstDue: '2026-11-09',
      amount: 88.88, confidence: 'estimated', payingAccount: 'chequing-a' };
    x.data.plan.obligations.push({ id, debtId: 'triangle', effect: 'payment',
      label: 'Invented card minimum (October)', frequency: 'once', date: '2026-10-10',
      amount: 100, confidence: 'confirmed', payingAccount: 'chequing-a',
      sentPayments: [{ scheduledDate: '2026-10-10', confirmed: true, intent: 'minimum',
        debitId: 'invented-bank-debit', postedOn: '2026-10-05', amount: 100, currency: 'cad',
        fundingAccountId: 'chequing-a', pending: false }] });
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
    const row = (period.bills || []).find(r => r.id === id);
    return { actual: period.budgetProgress.bills.actual, row };
  };
  const labelled = progress('triangle-oct');
  const control = progress('october-minimum');
  ok(labelled.row && labelled.row.date === '2026-10-10' && labelled.row.scheduledDue === '2026-10-09'
    && control.row && control.row.date === '2026-10-10' && control.row.scheduledDue === undefined,
    'the stood-in row keeps its real Oct 10 date; Oct 9 is only its printed due',
    JSON.stringify(labelled.row && [labelled.row.date, labelled.row.scheduledDue]));
  ok(labelled.actual.amount === 100 && control.actual.amount === 100
    && labelled.actual.completeness === control.actual.completeness,
    'bills actual counts the 100 sent, stood-in or standalone',
    JSON.stringify({ labelled: labelled.actual.amount, control: control.actual.amount }));
}

console.log('\n=== 11. only the bill-row printers read scheduledDue ===');
{
  // Guard: row.date is the one occurrence authority. Forecast writes
  // scheduledDue once, in calendarBillSections, and never reads it back, so
  // a guessed stand-in cannot decide a window, an amount or whether another
  // row is listed. Only the printers read it. The roster row hands the
  // printed due to the at-a-glance list as the DOM attribute
  // data-budget-bill-due; that list is checked in case 13.
  const ALLOWED = {
    'public/plan.js': ['glanceLineLabel', 'budgetBillBrowseRowHtml'],
    'public/bill-detail.js': ['html'],
  };
  const files = fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.js')).map(f => 'public/' + f)
    .concat(fs.readdirSync(path.join(ROOT, 'scripts')).filter(f => f.endsWith('.js')).map(f => 'scripts/' + f), ['server.js']);
  const offenders = [];
  for (const file of files) {
    // Comments are prose, not readers.
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    let at = src.indexOf('scheduledDue');
    while (at >= 0) {
      const before = src.slice(0, at);
      const fns = [...before.matchAll(/function\s+([A-Za-z0-9_$]+)\s*\(/g)];
      const name = fns.length ? fns[fns.length - 1][1] : '(top level)';
      const write = file === 'public/forecast.js' && name === 'calendarBillSections'
        && /row\.$/.test(before) && /^scheduledDue = scheduleDate;/.test(src.slice(at));
      if (!write && !(ALLOWED[file] || []).includes(name)) offenders.push(`${file}:${before.split('\n').length} in ${name}`);
      at = src.indexOf('scheduledDue', at + 1);
    }
  }
  ok(offenders.length === 0, 'Forecast writes scheduledDue once and nothing but the printers reads it', offenders.join(', '));
  const forecast = fs.readFileSync(path.join(ROOT, 'public/forecast.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  ok(forecast.split('scheduledDue').length - 1 === 1, 'positive control: the one write is there',
    String(forecast.split('scheduledDue').length - 1));
}

console.log('\n=== 12. a one-off dated after the recurring day, in a month the recurring bill is itself due ===');
{
  // Recurring phone 160 on day 15, due Sep 15 itself. A one-off dated Sep 17
  // is not a stand-in (the recurring row emits Sep 15), so both count in
  // this period and the one-off prints its own date:
  //   160 (Sep 15) + 283.94 (Sep 17) + hydro 200 (Sep 18) = 643.94.
  const bills = 160 + 283.94 + 200;
  const data = served({ day: 15 }, { date: '2026-09-17' });
  const html = renderBudget(data);
  ok(term(html, 'assignedBills') === money(bills), `assigned bills are ${money(bills)}`, term(html, 'assignedBills'));
  ok(term(html, 'balanceAfterDeductions') === money(5000 - bills),
    `Balance After Deductions is ${money(5000 - bills)}`, term(html, 'balanceAfterDeductions'));
  ok(billLine(html, 'Invented phone one-off') === 'Sep 17' && billLine(html, 'Invented phone') === 'Sep 15',
    'the one-off prints Sep 17 and the recurring bill prints Sep 15',
    billLine(html, 'Invented phone one-off') + ' / ' + billLine(html, 'Invented phone'));
  const row = (F.recommend(data.plan, AS_OF, {}).defaultView.billSections || [])
    .flatMap(sec => sec.rows || []).filter(r => r.id === 'phone-one-off');
  ok(row.length === 1 && row[0].date === '2026-09-17' && row[0].scheduledDue === undefined,
    'one row, dated Sep 17, with no scheduled due');
}

console.log('\n=== 13. first and last day of a pay period, and the at-a-glance list attributes ===');
{
  // Sep 24 is the last day of this period and Sep 25 the first day of the
  // next. Filed beside a recurring bill that is due on the 20th itself:
  //   dated Sep 24 -> this period: 160 (Sep 20) + 283.94 + hydro 200 = 643.94
  //   dated Sep 25 -> next period: this period 360; next 5,000 - 283.94
  const last = renderBudget(served({ day: 20 }, { date: '2026-09-24' }));
  ok(term(last, 'assignedBills') === money(643.94) && timelineBad(last, '2026-09-25') === money(5000),
    'dated the last day: counted in this period only', term(last, 'assignedBills') + ' / ' + timelineBad(last, '2026-09-25'));
  const first = renderBudget(served({ day: 20 }, { date: '2026-09-25' }));
  ok(term(first, 'assignedBills') === money(360) && timelineBad(first, '2026-09-25') === money(5000 - 283.94),
    'dated the first day of the next period: counted in the next period only',
    term(first, 'assignedBills') + ' / ' + timelineBad(first, '2026-09-25'));
  // The roster row keeps the real date for identity and hands a differing
  // printed due to the at-a-glance list (budget-blend.js) as its own
  // attribute. Case 4's stand-in: real Sep 11, printed Sep 10.
  const standIn = renderBudget(served({ day: 10, firstDue: '2026-10-10' }, { date: '2026-09-11' }));
  const button = /<button[^>]*data-budget-bill-open="phone-one-off"[^>]*data-budget-browse-origin="bills"[^>]*>/.exec(standIn);
  ok(button && /data-budget-bill-date="2026-09-11"/.test(button[0]) && /data-budget-bill-due="2026-09-10"/.test(button[0]),
    'the stand-in roster row carries its real date and its printed due', button && button[0]);
  const plain = /<button[^>]*data-budget-bill-open="hydro"[^>]*data-budget-browse-origin="bills"[^>]*>/.exec(standIn);
  ok(plain && /data-budget-bill-date="2026-09-18"/.test(plain[0]) && !/data-budget-bill-due/.test(plain[0]),
    'an ordinary row carries no separate printed due', plain && plain[0]);
  const blend = fs.readFileSync(path.join(ROOT, 'public/budget-blend.js'), 'utf8');
  ok(/getAttribute\('data-budget-bill-due'\)/.test(blend), 'the at-a-glance list reads that printed due');
}

console.log('\n=== 14. the viewer\'s timezone moves no bill between periods ===');
{
  // Dates are calendar days. Re-run case 1 and the two boundary days of
  // case 13 in child processes far east and far west of the household and
  // compare against the same hand-worked figures.
  if (process.argv.includes('--tz-probe')) {
    const one = renderBudget(served({ day: 15, firstDue: '2026-10-15' }, { date: '2026-09-14' }));
    const lastDay = renderBudget(served({ day: 20 }, { date: '2026-09-24' }));
    const firstDay = renderBudget(served({ day: 20 }, { date: '2026-09-25' }));
    console.log('TZ-PROBE ' + JSON.stringify([term(one, 'assignedBills'), billLine(one, 'Invented phone one-off'),
      term(lastDay, 'assignedBills'), billLine(lastDay, 'Invented phone one-off'),
      term(firstDay, 'assignedBills'), timelineBad(firstDay, '2026-09-25')]));
    process.exit(0);
  }
  const expected = JSON.stringify([money(483.94), 'Sep 14', money(643.94), 'Sep 24', money(360), money(5000 - 283.94)]);
  for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Vancouver']) {
    const out = require('node:child_process').execFileSync(process.execPath, [__filename, '--tz-probe'],
      { env: Object.assign({}, process.env, { TZ: zone }), encoding: 'utf8' });
    const line = out.split('\n').find(l => l.startsWith('TZ-PROBE ')) || '';
    ok(line.slice(9) === expected, `${zone}: same periods, same printed dates`, line.slice(9));
  }
}

console.log('\n=== 15. sweep: filed beside a recurring bill, a one-off reads exactly as when filed standalone ===');
{
  // Every day from Sep 4 to Oct 12 (both period boundaries, the recurring
  // day itself, a month end), with the recurring bill due every month or
  // first due in October. The control is the identical one-off under an id
  // that extends no recurring bill, which the schedule-date helper never
  // touches. Apart from the printed due, every published pay-period figure
  // must be identical, and the one-off must sit in the period that holds
  // its date (an unresolved one dated before this period is also carried
  // into it: the incumbent overdue rule, the same for the control).
  const plan = (id, firstDue, date) => served(Object.assign({ day: 20 }, firstDue ? { firstDue } : {}), { id, date }).plan;
  const strip = (advice, id) => JSON.stringify(advice.payPeriodViews, (k, v) => k === 'scheduledDue' ? undefined : v)
    .split(id).join('ONE-OFF');
  let compared = 0, different = 0, misplaced = 0, stoodIn = 0;
  for (let t = Date.parse('2026-09-04T12:00:00Z'); t <= Date.parse('2026-10-12T12:00:00Z'); t += 864e5) {
    const date = new Date(t).toISOString().slice(0, 10);
    for (const firstDue of [null, '2026-10-20']) {
      const beside = F.recommend(plan('phone-one-off', firstDue, date), AS_OF, {});
      const alone = F.recommend(plan('standalone-one-off', firstDue, date), AS_OF, {});
      compared++;
      if (strip(beside, 'phone-one-off') !== strip(alone, 'standalone-one-off')) different++;
      for (const view of beside.payPeriodViews) {
        for (const row of (view.bills || []).filter(r => r.id === 'phone-one-off')) {
          if (row.scheduledDue) stoodIn++;
          const own = view.start <= date && date <= view.end;
          const carried = date < view.start && view.role === 'active';
          if (row.date !== date || !(own || carried)) misplaced++;
        }
      }
    }
  }
  ok(compared === 78 && different === 0, `all ${compared} pairs publish identical pay-period figures`, `${different} differ`);
  ok(misplaced === 0, 'the one-off is never listed outside the period that holds its date', `${misplaced} misplaced`);
  ok(stoodIn > 0, 'positive control: the sweep includes rows that print a stood-in due', String(stoodIn));
}

console.log('\n=== 16. a printed stand-in due never adds or removes another row (same-debt control) ===');
{
  // Atlas finding on #1037. As-of and opening Sep 15. A monthly card payment
  // (debt invented-card) of 160 on day 12 with first due Oct 12: its Sep 12
  // occurrence is before the opening, so the list prints it once as inside
  // the opening. A one-off payment of 283.94 on the same debt is filed
  // beside it (id phone-one-off, which prints Sep 12 as its due) or
  // standalone. By hand:
  //   one-off dated Sep 25: this period's section totals 160, the next 283.94
  //   one-off dated Sep 14: this period's section totals 160 + 283.94 = 443.94
  // Filed beside the recurring payment, the printed due is the only change.
  const AS = '2026-09-15';
  const sections = (id, date) => {
    const data = served({}, {});
    data.meta.asOf = data.plan.opening.asOf = AS;
    data.plan.bills = [];
    data.plan.obligations = [
      { id: 'phone', debtId: 'invented-card', effect: 'payment', label: 'Invented card payment', frequency: 'monthly',
        day: 12, firstDue: '2026-10-12', amount: 160, confidence: 'confirmed', payingAccount: 'chequing-a' },
      { id, debtId: 'invented-card', effect: 'payment', label: 'Invented one-off payment', frequency: 'once',
        date, amount: 283.94, confidence: 'confirmed', payingAccount: 'chequing-a' }];
    data.debts = [{ id: 'invented-card', label: 'Invented card', secured: false, structure: 'Revolving',
      balance: 1000, rate: 19.99, payment: 160, pending: 0 }];
    const advice = F.recommend(data.plan, AS, { debts: data.debts });
    const stoodIn = (advice.defaultView.billSections || []).flatMap(sec => sec.rows || [])
      .filter(r => r.id === id && r.scheduledDue).map(r => r.scheduledDue);
    const strip = value => JSON.stringify(value, (k, v) => k === 'scheduledDue' ? undefined : v).split(id).join('ONE-OFF');
    const section = sid => (advice.defaultView.billSections || []).find(sec => sec.id === sid) || {};
    return { stoodIn, now: section('this-pay-period'), next: section('next-pay-period'),
      all: strip({ sections: advice.defaultView.billSections, views: advice.payPeriodViews }) };
  };
  const openingRow = sec => (sec.rows || []).filter(r => r.id === 'phone' && r.date === '2026-09-12').length;
  for (const [date, nowTotal, nextTotal] of [['2026-09-25', 160, 283.94], ['2026-09-14', 443.94, 0]]) {
    const beside = sections('phone-one-off', date), alone = sections('standalone', date);
    ok(beside.stoodIn.length > 0 && beside.stoodIn.every(d => d === '2026-09-12') && alone.stoodIn.length === 0,
      `one-off dated ${date}: positive control, filed beside it prints the Sep 12 due`, JSON.stringify(beside.stoodIn));
    ok(openingRow(beside.now) === 1 && openingRow(alone.now) === 1,
      `one-off dated ${date}: the recurring payment's Sep 12 opening row is listed either way`,
      openingRow(beside.now) + ' / ' + openingRow(alone.now));
    ok(Math.abs(beside.now.total - nowTotal) < 0.005 && Math.abs((beside.next.total || 0) - nextTotal) < 0.005,
      `one-off dated ${date}: section totals are ${money(nowTotal)} this period and ${money(nextTotal)} next`,
      beside.now.total + ' / ' + beside.next.total);
    ok(beside.all === alone.all, `one-off dated ${date}: every bill section and pay-period figure equals the standalone control`);
  }
}

console.log('\n=== 17. sweep on one debt: a one-off payment beside a recurring payment reads as when filed standalone ===');
{
  // The same comparison as case 15 for payment obligations that share a
  // debt, where the list also prints an inside-the-opening row for a
  // skipped recurring occurrence. As-of Sep 15; every day Sep 4 - Oct 12;
  // the recurring payment due every month or first due in October.
  const AS = '2026-09-15';
  const build = (id, firstDue, date) => {
    const data = served({}, {});
    data.meta.asOf = data.plan.opening.asOf = AS;
    data.plan.bills = [];
    data.plan.obligations = [
      Object.assign({ id: 'phone', debtId: 'invented-card', effect: 'payment', label: 'Invented card payment',
        frequency: 'monthly', day: 12, amount: 160, confidence: 'confirmed', payingAccount: 'chequing-a' },
      firstDue ? { firstDue } : {}),
      { id, debtId: 'invented-card', effect: 'payment', label: 'Invented one-off payment', frequency: 'once',
        date, amount: 283.94, confidence: 'confirmed', payingAccount: 'chequing-a' }];
    data.debts = [{ id: 'invented-card', label: 'Invented card', secured: false, structure: 'Revolving',
      balance: 1000, rate: 19.99, payment: 160, pending: 0 }];
    const advice = F.recommend(data.plan, AS, { debts: data.debts });
    return { stoodIn: JSON.stringify(advice.defaultView.billSections).includes('"scheduledDue"'),
      all: JSON.stringify({ sections: advice.defaultView.billSections, views: advice.payPeriodViews },
        (k, v) => k === 'scheduledDue' ? undefined : v).split(id).join('ONE-OFF') };
  };
  let compared = 0, different = 0, stoodIn = 0;
  for (let t = Date.parse('2026-09-04T12:00:00Z'); t <= Date.parse('2026-10-12T12:00:00Z'); t += 864e5) {
    const date = new Date(t).toISOString().slice(0, 10);
    for (const firstDue of [null, '2026-10-12']) {
      const beside = build('phone-one-off', firstDue, date), alone = build('standalone', firstDue, date);
      compared++;
      if (beside.stoodIn) stoodIn++;
      if (beside.all !== alone.all) different++;
    }
  }
  ok(compared === 78 && different === 0, `all ${compared} pairs publish identical bill sections and pay-period figures`,
    `${different} differ`);
  ok(stoodIn > 0, 'positive control: the sweep includes rows that print a stood-in due', String(stoodIn));
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
