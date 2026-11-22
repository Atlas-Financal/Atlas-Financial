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
 * hand from the inputs. The Stack page loads the same served packet and
 * draws the selected period's Bills card and waterfall.
 *
 * Pay periods (biweekly payday anchor Sep 11, 2026; as-of Sep 12):
 *   this period Sep 11 – Sep 24, next period Sep 25 – Oct 8.
 * Each period receives 5,000 pay. No budget categories, so
 *   Surplus after deductions = pay less the bills assigned to the period.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { loadStackPage } = require('./lib/budget-page-harness');
const { assertStackBillPeriod } = require('./lib/assert-stack-bill-period');
const F = require('../public/forecast');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${msg}${!cond && detail ? `  — ${detail}` : ''}`);
  if (!cond) failures++;
};
const money = n => '$' + n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const AS_OF = '2026-09-12';
function served(recurring, oneOff) {
  return {
    meta: { asOf: AS_OF, title: 'Invented one-off household' },
    accounts: [], revolvingExtra: [], debts: [],
    plan: {
      windowDays: 91,
      opening: { asOf: AS_OF },
      startingCash: { breakdown: [{ id: 'chequing-a', label: 'Invented bills account', value: 5000 }, { id: 'chequing-b', value: 0 }] },
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

const ACTIVE = '2026-09-11';
const NEXT = '2026-09-25';
const hydro = ['hydro', '2026-09-18'];
const recurring = date => ['phone', date];
const once = date => ['phone-one-off', date];

// The scenario assigns each input bill to a period by hand. The expected
// deduction and surplus use those inputs, independently of the published rows.
async function checkWindows(data, current, next) {
  const page = await loadStackPage({ data });
  for (const [start, members] of [[ACTIVE, current], [NEXT, next]]) {
    const rows = members.map(([id, date]) => {
      const bill = data.plan.bills.find(b => b.id === id);
      assert.ok(bill, 'bill belongs to the fixture');
      return [bill, date];
    });
    const billCents = rows.reduce((sum, [bill]) => sum + Math.round(bill.amount * 100), 0);
    const payCents = Math.round(data.plan.income[0].amount * 100);
    assertStackBillPeriod(page, start, { bills: billCents / 100, surplus: (payCents - billCents) / 100 }, rows);
  }
  return page.context().recommendation.defaultView.billSections;
}

async function checkBoundaryDates() {
  const before = served({ day: 15, firstDue: '2026-10-15' }, { date: '2026-09-14' });
  await checkWindows(before, [once('2026-09-14'), hydro], []);
  const talk = F.currentPeriodObligationStates(before.plan, AS_OF, {});
  assert.ok(talk.bills.some(r => r.id === 'phone-one-off' && r.date === '2026-09-14'
    && r.remaining === before.plan.bills[1].amount), 'Talk and the active Bills card include the same one-off');

  const regular = [hydro, recurring('2026-09-20')];
  const last = served({ day: 20 }, { date: '2026-09-24' });
  await checkWindows(last, [...regular, once('2026-09-24')], []);
  const first = served({ day: 20 }, { date: NEXT });
  await checkWindows(first, regular, [once(NEXT)]);
}

async function checkStandIns() {
  const date = '2026-10-05';
  const future = served({ day: 20, firstDue: '2026-11-20' }, { date });
  await checkWindows(future, [hydro], [once(date)]);

  const standIn = served({ day: 20, firstDue: '2026-10-20' }, { date });
  const sections = await checkWindows(standIn, [hydro], [once(date)]);
  const nextRow = sections.find(s => s.start === NEXT).rows.find(r => r.id === 'phone-one-off');
  assert.equal(nextRow.date, date, 'membership follows the real occurrence');
  assert.equal(nextRow.scheduledDue, '2026-09-20', 'Forecast retains the skipped due');

  const payday = served({ day: 10, firstDue: '2026-10-10' }, { date: ACTIVE });
  const onPayday = await checkWindows(payday, [once(ACTIVE), hydro], []);
  const holders = onPayday.filter(s => s.rows.some(r => r.id === 'phone-one-off'));
  assert.equal(holders.length, 1, 'one period owns the payday stand-in');
  const row = holders[0].rows.find(r => r.id === 'phone-one-off');
  assert.equal(holders[0].start, ACTIVE);
  assert.equal(row.date, ACTIVE);
  assert.equal(row.scheduledDue, '2026-09-10');

  const represented = served({ day: 20, firstDue: '2026-10-20' }, { date });
  represented.meta.asOf = represented.plan.opening.asOf = '2026-09-24';
  represented.plan.opening.representedEvents = [{ id: 'phone-one-off', date }];
  const futurePaid = await checkWindows(represented, [hydro], [once(date)]);
  const planned = futurePaid.find(s => s.start === NEXT).rows.find(r => r.id === 'phone-one-off');
  assert.notEqual(planned.status, 'PAID', 'a future occurrence stays planned');
  assert.equal(planned.remaining, represented.plan.bills[1].amount, 'its full amount remains');

  // The paid occurrence left after the payday snapshot. An earlier scheduled
  // due must leave the same deduction as the standalone payment.
  for (const id of ['phone-one-off', 'standalone-one-off']) {
    const paidDate = '2026-09-16';
    const data = served({ day: 10, firstDue: '2026-10-10' }, { id, date: paidDate });
    data.meta.asOf = paidDate;
    data.plan.opening = { asOf: paidDate, priorAsOf: ACTIVE,
      paydaySnapshot: { periodStart: ACTIVE, asOf: ACTIVE, opening: data.plan.income[0].amount },
      representedEvents: [{ id, date: paidDate }] };
    const paidSections = await checkWindows(data, [[id, paidDate], hydro], []);
    const paid = paidSections.find(s => s.start === ACTIVE).rows.find(r => r.id === id);
    assert.equal(paid.scheduledDue, id === 'phone-one-off' ? '2026-09-10' : undefined);
  }

  const separate = served({ day: 15 }, { date: '2026-09-17' });
  const both = await checkWindows(separate, [recurring('2026-09-15'), once('2026-09-17'), hydro], []);
  const occurrences = both.flatMap(s => s.rows).filter(r => r.id === 'phone-one-off');
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].date, '2026-09-17');
  assert.equal(occurrences[0].scheduledDue, undefined, 'an extra one-off displaces no recurring due');
}

function checkPaidProgress() {
  console.log('\n=== 8. Budget progress counts a paid one-off by its real date, not its printed due ===');
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

function checkZeroProgress() {
  console.log('\n=== 9. Budget progress: an unpaid one-off due after as-of is known $0 paid, not Unknown ===');
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

function checkSentEvidence() {
  console.log('\n=== 10. a stood-in one-off card minimum with qualified sent evidence keeps its paid progress ===');
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

function checkScheduledDueReaders() {
  console.log('\n=== 11. only the bill-row printers read scheduledDue ===');
  // Guard: row.date is the one occurrence authority. Forecast writes
  // scheduledDue once, in calendarBillSections, and never reads it back, so
  // a guessed stand-in cannot decide a window, an amount or whether another
  // row is listed. Only the printers read it. The roster row hands the
  // printed due to the at-a-glance list as the DOM attribute
  // data-budget-bill-due. Its source binding stays until S7. A saved close
  // (applyCapturedPeriodHistory) copies it from today's row for the same
  // occurrence and decides nothing with it
  // (test-captured-close-printed-due.js).
  const blend = fs.readFileSync(path.join(ROOT, 'public/budget-blend.js'), 'utf8');
  ok(/getAttribute\('data-budget-bill-due'\)/.test(blend), 'the classic list still reads the printed due');
  const ALLOWED = {
    'public/forecast.js': ['applyCapturedPeriodHistory'],
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
  ok(forecast.split('row.scheduledDue = scheduleDate;').length - 1 === 1, 'positive control: the one write is there',
    String(forecast.split('row.scheduledDue = scheduleDate;').length - 1));
}

function checkBillSweep() {
  console.log('\n=== 15. sweep: filed beside a recurring bill, a one-off reads exactly as when filed standalone ===');
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

function checkSameDebt() {
  console.log('\n=== 16. a printed stand-in due never adds or removes another row (same-debt control) ===');
  // Atlas finding on #1037. As-of and opening Sep 15. A monthly card payment
  // (debt invented-card) of 160 on day 12 with first due Oct 12: its Sep 12
  // occurrence is before its own Oct 12 firstDue, so it is no assigned
  // occurrence and is not listed (#977 pre-review: it was listed and
  // totalled but deducted nowhere). A one-off payment of 283.94 on the same
  // debt is filed beside it (id phone-one-off, which prints Sep 12 as its
  // due) or standalone. By hand:
  //   one-off dated Sep 25: this period's section totals 0, the next 283.94
  //   one-off dated Sep 14: this period's section totals 283.94, the next 0
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
  for (const [date, nowTotal, nextTotal] of [['2026-09-25', 0, 283.94], ['2026-09-14', 283.94, 0]]) {
    const beside = sections('phone-one-off', date), alone = sections('standalone', date);
    ok(beside.stoodIn.length > 0 && beside.stoodIn.every(d => d === '2026-09-12') && alone.stoodIn.length === 0,
      `one-off dated ${date}: positive control, filed beside it prints the Sep 12 due`, JSON.stringify(beside.stoodIn));
    ok(openingRow(beside.now) === 0 && openingRow(alone.now) === 0,
      `one-off dated ${date}: the recurring payment's Sep 12 minimum before its firstDue is listed neither way`,
      openingRow(beside.now) + ' / ' + openingRow(alone.now));
    ok(Math.abs(beside.now.total - nowTotal) < 0.005 && Math.abs((beside.next.total || 0) - nextTotal) < 0.005,
      `one-off dated ${date}: section totals are ${money(nowTotal)} this period and ${money(nextTotal)} next`,
      beside.now.total + ' / ' + beside.next.total);
    ok(beside.all === alone.all, `one-off dated ${date}: every bill section and pay-period figure equals the standalone control`);
  }
}

function checkSameDebtSweep() {
  console.log('\n=== 17. sweep on one debt: a one-off payment beside a recurring payment reads as when filed standalone ===');
  // The same comparison as case 15 for payment obligations that share a
  // debt, where the recurring payment also has a
  // skipped occurrence before its firstDue (not listed). As-of Sep 15; every day Sep 4 - Oct 12;
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

async function main() {
  await checkBoundaryDates();
  if (process.argv.includes('--tz-probe')) return;
  await checkStandIns();
  for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Vancouver']) {
    execFileSync(process.execPath, [__filename, '--tz-probe'], { env: { ...process.env, TZ: zone } });
    ok(true, zone + ' preserves the selected bill dates, deductions and surplus');
  }
  checkPaidProgress();
  checkZeroProgress();
  checkSentEvidence();
  checkScheduledDueReaders();
  checkBillSweep();
  checkSameDebt();
  checkSameDebtSweep();
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  if (failures) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
