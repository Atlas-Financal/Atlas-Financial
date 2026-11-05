'use strict';
/* Budget timeline: one chronological Budget-shaped Seaspan sequence.
 *
 * Expected cents below are literal arithmetic on this fixture. They are
 * not copied from Forecast helper output.
 *
 * Seaspan anchor 2026-08-14, +14 days. As-of 2026-10-09:
 *   current  Oct 9–22     Dale 4000 + Amanda 15th 2000 + child benefit Oct 20 500 = 6500
 *                        bills 0; Household Budget 200 + 150 + 100 = 450
 *                        BAD 6500 − 0 − 450 = 6050
 *   next     Oct 23–Nov 5 Dale 4000 + Amanda month-end Oct 31 1500 = 5500
 *                        mortgage Nov 1 1600 + hydro Nov 3 199 = 1799
 *                        Household Budget 200 + 150 + 0 = 350
 *                        BAD 5500 − 1799 − 350 = 3351
 *   N+2      Nov 6–19     Dale 4000 + Amanda Nov 15 2000 = 6000
 *                        bills 0; Household Budget 450; BAD 5550
 *   N+3      Nov 20–Dec 3 Dale 4000 + Amanda Nov 30 (day 31 clamped) 1500
 *                        + child benefit Nov 20 500 = 6000
 *                        mortgage Dec 1 1600 + hydro Dec 3 199 = 1799
 *                        Household Budget 350; BAD 3851
 *
 * Household Budget on a future or current row with no actuals:
 *   groceries plannedWeekly 100 → 200; dale-guilt-free plannedPayday 150;
 *   pets 100 only on the first Seaspan start of that calendar month
 *   (Oct 9, Nov 6, Dec 4), else 0.
 *
 * `node test/test-budget-timeline-pay-periods.js`
 */
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= eps;
const iso = (y, m, d) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function addCalendarDays(date, n) {
  const [y, m, d] = String(date).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
function roundCent(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

const ANCHOR = '2026-08-14';
const AS_OF = '2026-10-09';
const DALE = 4000;
const AMANDA_15 = 2000;
const AMANDA_END = 1500;
const CHILD = 500;
const MORTGAGE = 1600;
const HYDRO = 199;
const GROCERY_CYCLE = 200;
const DALE_FREE = 150;
const PETS = 100;
const MODELLED_THROUGH = '2026-12-31';

const debts = [];

function timelinePlan(asOf, extra) {
  extra = extra || {};
  return {
    defaults: { targetBuffer: 500 },
    windowDays: 91,
    startingCash: {
      breakdown: [{
        id: 'chequing-a', label: 'BILLS ACCOUNT', value: 2000, class: 'spendable',
      }],
    },
    opening: Object.assign({ asOf }, extra.opening || {}),
    nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
    income: [
      {
        id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
        anchor: ANCHOR, amount: DALE, confidence: 'confirmed',
      },
      {
        id: 'amandaSalary15', label: 'Amanda salary — 15th', frequency: 'monthly',
        day: 15, amount: AMANDA_15, confidence: 'confirmed',
      },
      {
        id: 'amandaSalaryMonthEnd', label: 'Amanda salary — month-end', frequency: 'monthly',
        day: 31, amount: AMANDA_END, confidence: 'confirmed',
      },
      {
        id: 'childBenefit', label: 'Child benefit', frequency: 'monthly',
        day: 20, amount: CHILD, confidence: 'confirmed',
      },
    ],
    bills: [
      {
        id: 'mortgage', label: 'Mortgage', amount: MORTGAGE,
        frequency: 'monthly', day: 1, confidence: 'confirmed',
        payingAccount: 'chequing-a',
      },
      {
        id: 'hydro', label: 'Hydro', amount: HYDRO,
        frequency: 'monthly', day: 3, confidence: 'confirmed',
        payingAccount: 'chequing-a',
      },
    ].concat(extra.bills || []),
    obligations: [],
    commitments: [],
    budget: {
      categories: [
        { id: 'groceries', label: 'Groceries', plannedWeekly: 100 },
        { id: 'dale-guilt-free', label: 'Dale guilt-free spending', plannedPayday: DALE_FREE },
        {
          id: 'pets', label: 'Dog food', plannedPayday: PETS,
          paydayCadence: 'first-seaspan-of-month',
        },
      ],
    },
  };
}

function recommend(plan, asOf, opts) {
  return F.recommend(plan, asOf || AS_OF, Object.assign({
    targetBuffer: 500,
    debts,
  }, opts || {}));
}

function rowByRole(advice, role) {
  return (advice.payPeriodViews || []).find(p => p && p.timelineRole === role) || null;
}
function rowByStart(advice, start) {
  return (advice.payPeriodViews || []).find(p => p && p.start === start) || null;
}
function incomeOn(period, id, date) {
  return ((period && period.income) || []).filter(r => r && r.id === id && r.date === date);
}
function billOn(period, id, date) {
  return ((period && period.bills) || []).filter(r => r && r.id === id && r.date === date);
}
function budgetItem(period, id) {
  return ((period && period.householdBudget) || []).find(r => r && r.id === id) || null;
}
function holdFor(pets) {
  return roundCent(GROCERY_CYCLE + DALE_FREE + pets);
}

const CURRENT = { start: '2026-10-09', end: '2026-10-22', income: 6500, bills: 0, hold: holdFor(PETS), bad: 6050 };
const NEXT = { start: '2026-10-23', end: '2026-11-05', income: 5500, bills: roundCent(MORTGAGE + HYDRO), hold: holdFor(0), bad: 3351 };
const N2 = { start: '2026-11-06', end: '2026-11-19', income: 6000, bills: 0, hold: holdFor(PETS), bad: 5550 };
const N3 = { start: '2026-11-20', end: '2026-12-03', income: 6000, bills: roundCent(MORTGAGE + HYDRO), hold: holdFor(0), bad: 3851 };

function expectPeriod(period, spec, label) {
  ok(!!period, label + ' exists');
  if (!period) return;
  ok(period.start === spec.start && period.end === spec.end,
    label + ' dates', `${period.start}..${period.end}`);
  ok(near(period.incomeTotal, spec.income),
    label + ' income', `${period.incomeTotal} vs ${spec.income}`);
  ok(near(period.periodBillLoad, spec.bills),
    label + ' bills', `${period.periodBillLoad} vs ${spec.bills}`);
  ok(near(period.budgetHold, spec.hold),
    label + ' household budget', `${period.budgetHold} vs ${spec.hold}`);
  ok(near(period.balanceAfterDeductions, spec.bad),
    label + ' BAD', `${period.balanceAfterDeductions} vs ${spec.bad}`);
  ok(near(period.balanceAfterDeductions, roundCent(spec.income - spec.bills - spec.hold)),
    label + ' BAD is income − bills − household budget');
  const terms = period.predictedEndingBalanceTerms;
  ok(terms && terms.closes === true && terms.identity === 'balance-after-deductions',
    label + ' terms close on balance-after-deductions');
  ok(terms && !Object.prototype.hasOwnProperty.call(terms, 'opening'),
    label + ' opening is not a BAD term');
}

console.log('=== 1. current row is the incumbent calendar period, to the cent ===');
{
  const plan = timelinePlan(AS_OF);
  const advice = recommend(plan);
  const periods = advice.defaultView.calendarPeriods || [];
  const current = rowByRole(advice, 'current');
  ok(periods.length === 2, 'calendarPeriods stays two rows', 'length=' + periods.length);
  ok(periods[0] && periods[0].id === 'this-pay-period', 'first calendar row is This Pay Period');
  ok(current === periods[0], 'timeline current is the same object as calendarPeriods[0]');
  expectPeriod(current, CURRENT, 'current');
  ok(current && current.timelineOffset === 0 && current.evidenceState === 'live',
    'current labels are offset 0 and live evidence');
  const pets = budgetItem(current, 'pets');
  ok(pets && near(pets.planned, PETS), 'Oct 9 is the first Seaspan start of October, so dog food is 100');
}

console.log('\n=== 2. timeline next is Budget Next Pay Period; nextPeriodView is not ===');
{
  const plan = timelinePlan(AS_OF);
  const advice = recommend(plan);
  const periods = advice.defaultView.calendarPeriods || [];
  const next = rowByRole(advice, 'next');
  ok(periods[1] && periods[1].id === 'next-pay-period', 'second calendar row is Next Pay Period');
  ok(next === periods[1], 'timeline next is the same object as calendarPeriods[1]');
  expectPeriod(next, NEXT, 'timeline next');
  ok(next && next.timelineRole === 'next' && next.evidenceState === 'projected',
    'timeline next is projected evidence on Budget\'s next row');
  ok(next && next.openingLabel == null,
    'the shared Budget next row does not gain a second opening label');
  const lookahead = advice.nextPeriodView;
  ok(lookahead && lookahead !== next, 'nextPeriodView is a different object');
  ok(lookahead.periodStart === NEXT.start && lookahead.periodEnd === NEXT.end,
    'nextPeriodView still spans the next Seaspan cycle');
  ok(lookahead.balanceAfterDeductions == null
      && lookahead.predictedEndingBalanceIdentity == null,
    'nextPeriodView publishes no Balance After Deductions identity');
  ok(lookahead.cashNote === 'Current Balance. Not credit. Opening this pay period.',
    'nextPeriodView keeps the lookahead cash note');
  const lookBudget = lookahead.householdBudget || [];
  const groceries = lookBudget.find(r => r && r.id === 'groceries');
  ok(groceries && near(groceries.amount, GROCERY_CYCLE),
    'lookahead groceries are the 14-day weekly scale, 200');
  ok(!lookBudget.some(r => r && r.id === 'dale-guilt-free'),
    'lookahead ten-block omits dale-guilt-free, which Budget\'s next row holds');
  ok(!near(lookahead.afterHouseholdBudget, NEXT.bad),
    'lookahead leftover is not Budget next BAD',
    `${lookahead.afterHouseholdBudget} vs ${NEXT.bad}`);
  ok(!(advice.payPeriodViews || []).some(p => p && p.id && String(p.id).indexOf('future:') === 0
      && periods.indexOf(p) >= 0),
    'further future rows are not added to calendarPeriods');
}

console.log('\n=== 3. N+2 and N+3 BAD match the hand arithmetic ===');
{
  const advice = recommend(timelinePlan(AS_OF));
  const futures = (advice.payPeriodViews || []).filter(p => p && p.timelineRole === 'future');
  ok(futures.length === 4, 'four further future cycles fit before 2026-12-31',
    'count=' + futures.length);
  expectPeriod(futures[0], N2, 'N+2');
  expectPeriod(futures[1], N3, 'N+3');
  ok(futures[0] && futures[0].timelineOffset === 2, 'N+2 offset is +2');
  ok(futures[1] && futures[1].timelineOffset === 3, 'N+3 offset is +3');
  ok(near(N2.bad, roundCent(6000 - 0 - holdFor(PETS))), 'N+2 literal 6000 − 0 − 450 = 5550');
  ok(near(N3.bad, roundCent(6000 - (MORTGAGE + HYDRO) - holdFor(0))),
    'N+3 literal 6000 − 1799 − 350 = 3851');
}

console.log('\n=== 4. each dated item lands in exactly one period ===');
{
  const advice = recommend(timelinePlan(AS_OF));
  const views = advice.payPeriodViews || [];
  function placements(id, date, kind) {
    const hits = [];
    for (const period of views) {
      const rows = kind === 'bill' ? billOn(period, id, date) : incomeOn(period, id, date);
      if (rows.length) hits.push(period.start);
    }
    return hits;
  }
  function once(id, date, kind, start, label) {
    const hits = placements(id, date, kind);
    ok(hits.length === 1 && hits[0] === start,
      label, `hits=${hits.join(',') || 'none'}`);
  }
  once('payroll', '2026-10-09', 'income', CURRENT.start, 'Dale Oct 9 is current');
  once('payroll', '2026-10-23', 'income', NEXT.start, 'Dale Oct 23 is next');
  once('payroll', '2026-11-06', 'income', N2.start, 'Dale Nov 6 is N+2');
  once('payroll', '2026-11-20', 'income', N3.start, 'Dale Nov 20 is N+3');
  once('payroll', '2026-12-04', 'income', '2026-12-04', 'Dale Dec 4 is that cycle');
  once('payroll', '2026-12-18', 'income', '2026-12-18', 'Dale Dec 18 is that cycle');
  ok(placements('payroll', '2027-01-01', 'income').length === 0,
    'Dale Jan 1 2027 is not published');
  once('amandaSalary15', '2026-10-15', 'income', CURRENT.start, 'Amanda Oct 15 is current');
  once('amandaSalary15', '2026-11-15', 'income', N2.start, 'Amanda Nov 15 is N+2');
  once('amandaSalary15', '2026-12-15', 'income', '2026-12-04', 'Amanda Dec 15 is Dec 4–17');
  ok(placements('amandaSalary15', '2027-01-15', 'income').length === 0,
    'Amanda Jan 15 2027 is not published');
  once('amandaSalaryMonthEnd', '2026-10-31', 'income', NEXT.start,
    'Amanda Oct 31 is the cross-month next period');
  once('amandaSalaryMonthEnd', '2026-11-30', 'income', N3.start,
    'Amanda day 31 clamps to Nov 30 and lands in Nov 20–Dec 3');
  ok(placements('amandaSalaryMonthEnd', '2026-11-31', 'income').length === 0,
    'November does not keep an unclamped day 31');
  once('amandaSalaryMonthEnd', '2026-12-31', 'income', '2026-12-18',
    'Amanda Dec 31 is Dec 18–31');
  ok(placements('amandaSalaryMonthEnd', '2027-02-28', 'income').length === 0,
    'February 2027 month-end clamp is outside the payroll boundary');
  once('childBenefit', '2026-10-20', 'income', CURRENT.start, 'Child benefit Oct 20 is current');
  once('childBenefit', '2026-11-20', 'income', N3.start, 'Child benefit Nov 20 opens that cycle');
  once('childBenefit', '2026-12-20', 'income', '2026-12-18', 'Child benefit Dec 20 is Dec 18–31');
  once('mortgage', '2026-11-01', 'bill', NEXT.start, 'Mortgage Nov 1 is the cross-month next period');
  once('mortgage', '2026-12-01', 'bill', N3.start, 'Mortgage Dec 1 is Nov 20–Dec 3');
  ok(placements('mortgage', '2027-01-01', 'bill').length === 0,
    'Mortgage Jan 1 2027 is not published');
  once('hydro', '2026-11-03', 'bill', NEXT.start, 'Hydro Nov 3 is the cross-month next period');
  once('hydro', '2026-12-03', 'bill', N3.start, 'Hydro Dec 3 is the last day of Nov 20–Dec 3');
  const cross = rowByStart(advice, NEXT.start);
  ok(cross && incomeOn(cross, 'amandaSalaryMonthEnd', '2026-10-31').length === 1
      && billOn(cross, 'mortgage', '2026-11-01').length === 1
      && billOn(cross, 'hydro', '2026-11-03').length === 1
      && incomeOn(cross, 'payroll', '2026-10-23').length === 1,
    'the Oct 23–Nov 5 cross-month period holds Dale, Amanda month-end, mortgage, and hydro');
  ok(cross && incomeOn(cross, 'amandaSalary15', '2026-11-15').length === 0
      && incomeOn(cross, 'payroll', '2026-11-06').length === 0,
    'the cross-month period does not take the next cycle\'s payday or Amanda 15th');
  const petsStarts = views.filter(p => {
    const pets = budgetItem(p, 'pets');
    return pets && near(pets.planned, PETS) && p.timelineRole !== 'past';
  }).map(p => p.start);
  ok(petsStarts.join(',') === '2026-10-09,2026-11-06,2026-12-04',
    'dog food is assigned once, on the first Seaspan start of each month',
    petsStarts.join(','));
}

console.log('\n=== 5. future rows do not invent actuals ===');
{
  const advice = recommend(timelinePlan(AS_OF));
  const later = (advice.payPeriodViews || []).filter(p =>
    p && (p.timelineRole === 'next' || p.timelineRole === 'future'));
  ok(later.length >= 2, 'next and future rows are present');
  for (const period of later) {
    const paid = (period.bills || []).filter(b => b && (b.status === 'PAID' || b.glanceKind === 'paid'));
    ok(paid.length === 0, period.start + ' has no PAID bill without evidence',
      paid.map(b => b.id).join(','));
    ok(period.liveCurrentBalance == null, period.start + ' live Current Balance is null');
    ok(period.evidenceState === 'projected', period.start + ' evidence is projected');
    const items = period.householdBudget || [];
    ok(items.length > 0 && items.every(item => item && item.spent == null && item.projected === true),
      period.start + ' household budget spent is null and projected');
    if (period.timelineRole === 'future') {
      ok(period.openingLabel === 'Projected period cash',
        period.start + ' opening is labelled projected period cash');
      ok(period.cashNote && /Projected opening/.test(period.cashNote)
          && !/today's balance\.$/.test(period.cashNote.replace('Not today\'s balance.', '')),
        period.start + ' cash note is a projected opening');
    }
  }
  ok(!(advice.payPeriodTimeline && Object.prototype.hasOwnProperty.call(
    advice.payPeriodTimeline, 'extraDebt')),
    'the timeline does not publish an extra-debt total');
  ok(['count', 'currentIndex', 'horizonReason', 'incomeRegimeBoundary', 'through']
    .every(key => Object.prototype.hasOwnProperty.call(advice.payPeriodTimeline, key))
    && Object.keys(advice.payPeriodTimeline).length === 5,
    'payPeriodTimeline has only the bound fields');
}

console.log('\n=== 5b. a represented occurrence after asOf stays planned and stays in the bill load ===');
{
  const plan = timelinePlan(AS_OF, {
    opening: {
      representedEvents: [
        { id: 'represented-future', date: '2026-11-10' },
        { id: 'represented-next', date: '2026-10-24' },
        { id: 'represented-past', date: '2026-09-28' },
        { id: 'represented-today', date: '2026-10-09' },
      ],
    },
    bills: [
      {
        id: 'represented-future', label: 'Represented future bill', amount: 42,
        frequency: 'once', date: '2026-11-10', confidence: 'confirmed',
        payingAccount: 'chequing-a',
      },
      {
        id: 'represented-next', label: 'Represented next bill', amount: 17,
        frequency: 'once', date: '2026-10-24', confidence: 'confirmed',
        payingAccount: 'chequing-a',
      },
      {
        id: 'represented-past', label: 'Represented past bill', amount: 11,
        frequency: 'once', date: '2026-09-28', confidence: 'confirmed',
        payingAccount: 'chequing-a',
      },
      {
        id: 'represented-today', label: 'Represented as-of bill', amount: 8,
        frequency: 'once', date: '2026-10-09', confidence: 'confirmed',
        payingAccount: 'chequing-a',
      },
    ],
  });
  const advice = recommend(plan);
  function hits(id, date) {
    const found = [];
    for (const period of advice.payPeriodViews || []) {
      for (const row of billOn(period, id, date)) {
        found.push({ start: period.start, role: period.timelineRole, row });
      }
    }
    return found;
  }
  function plannedFace(row) {
    return !!(row && row.status !== 'PAID' && row.glanceKind !== 'paid'
      && (row.status === 'planned' || row.status === 'projected')
      && (row.glanceKind === 'planned' || row.glanceKind === 'projected'));
  }
  const futureHits = hits('represented-future', '2026-11-10');
  const host = rowByStart(advice, N2.start);
  ok(futureHits.length === 1 && futureHits[0].start === N2.start
      && futureHits[0].role === 'future',
    'the Nov 10 represented bill is on N+2 once');
  ok(plannedFace(futureHits[0] && futureHits[0].row),
    'a represented Nov 10 occurrence after asOf stays planned, not PAID',
    futureHits[0] && futureHits[0].row.status);
  ok(futureHits[0] && futureHits[0].row.settlement !== 'represented'
      && futureHits[0].row.settlement === 'upcoming'
      && near(futureHits[0].row.remaining, 42)
      && near(futureHits[0].row.amount, 42) && near(futureHits[0].row.planned, 42),
    'that occurrence keeps its amount and is disclosed as not yet paid');
  ok(host && near(host.periodBillLoad, 42),
    'that occurrence stays in the bill load', String(host && host.periodBillLoad));
  ok(host && near(host.balanceAfterDeductions, roundCent(6000 - 42 - holdFor(PETS))),
    'N+2 BAD with the represented bill is 6000 − 42 − 450 = 5508',
    String(host && host.balanceAfterDeductions));

  const next = rowByRole(advice, 'next');
  const nextHits = hits('represented-next', '2026-10-24');
  ok(next === advice.defaultView.calendarPeriods[1],
    'Budget next is still calendarPeriods[1]');
  ok(nextHits.length === 1 && nextHits[0].role === 'next' && plannedFace(nextHits[0].row),
    'a represented Oct 24 occurrence on Next Pay Period stays planned',
    nextHits[0] && nextHits[0].row.status);
  ok(next && near(next.periodBillLoad, roundCent(MORTGAGE + HYDRO + 17)),
    'Next Pay Period bill load adds the 17 once',
    String(next && next.periodBillLoad));
  ok(next && near(next.balanceAfterDeductions, roundCent(NEXT.bad - 17)),
    'Next Pay Period BAD is the incumbent 3351 minus 17',
    String(next && next.balanceAfterDeductions));
  ok(billOn(next, 'mortgage', '2026-11-01').length === 1
      && billOn(next, 'hydro', '2026-11-03').length === 1,
    'the incumbent next-period bills are still counted once');
  ok(nextHits[0] && nextHits[0].row.settlement === 'upcoming'
      && near(nextHits[0].row.remaining, 17)
      && near(nextHits[0].row.amount, 17),
    'the Next Pay Period represented bill is remaining, not a settled disclosure');
  ok(next && near(next.paidBills, 0) && near(next.remainingBills, 1816)
      && near(next.totalBillsThisPeriod, 1816)
      && near(roundCent(next.paidBills + next.remainingBills), next.totalBillsThisPeriod),
    'Next paid bills 0 + remaining 1816 = total bills 1816',
    [next && next.paidBills, next && next.remainingBills, next && next.totalBillsThisPeriod].join(' / '));
  const n3 = rowByStart(advice, N3.start);
  ok(n3 && near(n3.paidBills, 0) && near(n3.remainingBills, roundCent(MORTGAGE + HYDRO))
      && near(n3.totalBillsThisPeriod, roundCent(MORTGAGE + HYDRO))
      && near(roundCent(n3.paidBills + n3.remainingBills), n3.totalBillsThisPeriod)
      && near(n3.periodBillLoad, roundCent(MORTGAGE + HYDRO))
      && near(n3.balanceAfterDeductions, N3.bad),
    'N+3 paid bills 0 + remaining 1799 = total bills 1799, and BAD stays 3851',
    n3 && [n3.paidBills, n3.remainingBills, n3.totalBillsThisPeriod, n3.balanceAfterDeductions].join(' / '));
  ok(host && near(host.paidBills, 0) && near(host.remainingBills, 42)
      && near(host.totalBillsThisPeriod, 42)
      && near(roundCent(host.paidBills + host.remainingBills), host.totalBillsThisPeriod),
    'N+2 paid bills 0 + remaining 42 = total bills 42');

  const pastHits = hits('represented-past', '2026-09-28');
  ok(pastHits.length === 1 && pastHits[0].role === 'past'
      && pastHits[0].row.status === 'PAID' && pastHits[0].row.glanceKind === 'paid'
      && near(pastHits[0].row.amount, 11),
    'a represented key dated before asOf stays PAID on the past row',
    pastHits.map(h => h.role + ':' + (h.row && h.row.status)).join(','));
  const todayHits = hits('represented-today', AS_OF);
  ok(todayHits.length === 1 && todayHits[0].role === 'current'
      && todayHits[0].row.status === 'PAID' && todayHits[0].row.glanceKind === 'paid'
      && todayHits[0].row.settlement === 'represented' && near(todayHits[0].row.remaining, 0),
    'a represented key dated on asOf stays PAID on the current row',
    todayHits.map(h => h.role + ':' + (h.row && h.row.status)).join(','));
  const current = rowByRole(advice, 'current');
  ok(current && near(current.paidBills, 8) && near(current.remainingBills, 0)
      && near(current.totalBillsThisPeriod, 8)
      && near(roundCent(current.paidBills + current.remainingBills), current.totalBillsThisPeriod)
      && near(current.periodBillLoad, 0) && near(current.balanceAfterDeductions, 6050),
    'the on-asOf bill stays in Paid bills, not Remaining, and BAD stays 6050',
    current && [current.paidBills, current.remainingBills, current.periodBillLoad, current.balanceAfterDeductions].join(' / '));
}

console.log('\n=== 5c. live plan keeps the bill load and moves only the paid disclosure ===');
{
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
  // This historical bill-load fixture owns a calculated ledger. A later
  // carried sender's cash-inclusion uncertainty is exercised separately.
  delete data.plan.obligations.find(row => row.id === 'mbna-aug31').sentPayments;
  // This fixed historical MATCH ledger predates Emerald's October amount
  // confirmation. Keep its original estimated minimum and hand totals;
  // current typed occurrence behavior has independent boundary coverage.
  const tdcc = data.plan.obligations.find(row => row.id === 'tdcc');
  delete tdcc.statementOccurrences;
  delete tdcc.sentPayments;
  const live = F.recommend(data.plan, data.meta.asOf, { debts: data.debts || [], targetBuffer: data.plan.defaults && data.plan.defaults.targetBuffer });
  const sep = rowByStart(live, '2026-09-11');
  ok(data.meta.asOf === '2026-08-19' && sep && sep.end === '2026-09-24' && sep.timelineRole === 'future',
    'repo as-of 2026-08-19 publishes Sep 11–24 as a future row');
  ok(sep && near(sep.paidBills, 0) && near(sep.remainingBills, 3424.26)
      && near(sep.totalBillsThisPeriod, 3424.26)
      && near(roundCent(sep.paidBills + sep.remainingBills), sep.totalBillsThisPeriod),
    'Sep 11–24 paid bills 0 + remaining 3424.26 = total bills',
    sep && [sep.paidBills, sep.remainingBills, sep.totalBillsThisPeriod].join(' / '));
  const FUTURE_OTHER = 400;
  ok(sep && near(sep.periodBillLoad, 3424.26) && near(sep.incomeTotal, 6652.30)
      && near(sep.budgetHold, roundCent(1725 + FUTURE_OTHER))
      && near(sep.balanceAfterDeductions, roundCent(6652.30 - 3424.26 - 1725 - FUTURE_OTHER)),
    'Sep 11–24 BAD is 6652.30 − 3424.26 − 1725 − 400 future Other Spend',
    sep && String(sep.balanceAfterDeductions));
  for (const spec of [
    ['tdcc', '2026-09-17', 94.03],
    ['noble-garbage', '2026-09-18', 95.85],
    ['heloc', '2026-09-21', 814.18],
  ]) {
    const rows = billOn(sep, spec[0], spec[1]);
    ok(rows.length === 1 && rows[0].status === 'planned' && rows[0].glanceKind === 'planned'
        && rows[0].settlement === 'upcoming' && near(rows[0].remaining, spec[2])
        && near(rows[0].amount, spec[2]),
      spec[0] + ' on Sep 11–24 is remaining once, not a paid disclosure');
  }
  ok(roundCent(94.03 + 95.85 + 814.18) === 1004.06,
    'those three lines are the 1004.06 that used to sit in Paid bills');

  const shifted = F.recommend(data.plan, '2026-09-25', {
    debts: data.debts || [],
    targetBuffer: data.plan.defaults && data.plan.defaults.targetBuffer,
  });
  const next = (shifted.defaultView.calendarPeriods || [])[1];
  // This future row crosses the approved October 9 Fuel boundary. Enumerate
  // the unchanged non-Fuel targets and both effective owner inputs directly.
  const oct9Hold = 900 + 200 + 150 + 150 + 555 + 450;
  // October 9-22 owns only these two new forward funding occurrences:
  // Paramount 13.43 on the 12th and STACKTV 16.79 on the 22nd. Ad-free
  // starts on the 25th; Crave starts November 9. No aggregate transfer.
  const handBillLoad = roundCent(3145.07 + 13.43 + 16.79);
  const hand = roundCent(6652.30 - handBillLoad - oct9Hold);
  ok(oct9Hold === 2405 && hand === 1072.01,
    'hand Next BAD is 6652.30 - (3145.07 + 13.43 + 16.79) - (1400 + 555 Fuel + 450 Other) = 1072.01', String(hand));
  ok(next && next.id === 'next-pay-period' && next.start === '2026-10-09' && next.end === '2026-10-22'
      && next === rowByRole(shifted, 'next'),
    'at Sep 25, Oct 9–22 is Budget Next Pay Period');
  ok(next && near(next.incomeTotal, 6652.30) && near(next.periodBillLoad, handBillLoad)
      && near(next.budgetHold, oct9Hold) && near(next.balanceAfterDeductions, hand),
    'that Next row keeps income - bill load - household budget, including dated 555 Fuel and 450 Other once',
    next && [next.incomeTotal, next.periodBillLoad, next.budgetHold, next.balanceAfterDeductions].join(' / '));
  ok(next && near(roundCent(next.paidBills + next.remainingBills), next.totalBillsThisPeriod)
      && near(next.periodBillLoad, next.totalBillsThisPeriod),
    'that Next row paid + remaining equals total bills, and the bill load is that total',
    next && [next.paidBills, next.remainingBills, next.totalBillsThisPeriod].join(' / '));
  ok(shifted.nextPeriodView && shifted.nextPeriodView !== next
      && shifted.nextPeriodView.balanceAfterDeductions == null,
    'More views nextPeriodView is a different object and has no Balance After Deductions');
}

console.log('\n=== 6. completed historical period is unchanged on the timeline ===');
{
  const historyAsOf = '2026-09-09';
  const plan = {
    defaults: { targetBuffer: 500 },
    startingCash: {
      breakdown: [{
        id: 'chequing-a', label: 'BILLS ACCOUNT', value: 2300, class: 'spendable',
      }],
    },
    opening: {
      asOf: historyAsOf,
      paydaySnapshot: { periodStart: '2026-08-28', asOf: '2026-08-28', opening: 1000 },
      representedEvents: [
        { id: 'bill-prev', date: '2026-08-21' },
        { id: 'bill-earlier', date: '2026-08-07' },
      ],
    },
    income: [
      {
        id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
        anchor: ANCHOR, amount: DALE, confidence: 'confirmed',
      },
      {
        id: 'amandaSalary15', label: 'Amanda salary — 15th', frequency: 'monthly',
        day: 15, amount: AMANDA_15, confidence: 'confirmed',
      },
    ],
    bills: [
      {
        id: 'bill-prev', label: 'Synthetic previous bill', amount: 80,
        frequency: 'once', date: '2026-08-21', confidence: 'confirmed',
      },
      {
        id: 'bill-earlier', label: 'Synthetic earlier bill', amount: 90,
        frequency: 'once', date: '2026-08-07', confidence: 'confirmed',
      },
      {
        id: 'bill-recur-prev', label: 'Synthetic recurring previous',
        amount: 120, frequency: 'monthly', day: 21,
        confidence: 'confirmed', payingAccount: 'chequing-a',
      },
    ],
    obligations: [],
    commitments: [],
    budget: {
      categories: [{
        id: 'groceries', label: 'Groceries', class: 'essential',
        plannedWeekly: 100, ownerLine: 'Groceries', from: ['Groceries'],
      }],
    },
  };
  const actuals = {
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: historyAsOf,
    coverageStart: '2026-07-31',
    coverageThrough: historyAsOf,
    pendingCoverage: 'complete', transactionCoverage: 'complete',
    transactions: [
      {
        id: 'tx-past-gift', date: '2026-08-20', amount: -50, isIncome: true,
        categoryLabel: 'gifts', displayedPayee: 'Past gift', accountRole: 'household-cash',
      },
      {
        id: 'tx-grocery-prev', date: '2026-08-20', amount: 40, pending: false,
        categoryLabel: 'Groceries', accountRole: 'household-cash',
        displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods',
      },
    ],
    representedActuals: [],
  };
  const advice = F.recommend(plan, historyAsOf, {
    targetBuffer: 500,
    debts: [{
      id: 'triangle', label: 'Triangle', secured: false, structure: 'Revolving',
      balance: 2000, rate: 21.99, payment: 250, pending: 0,
    }],
    currentPeriodActuals: actuals,
    paydaySnapshot: plan.opening.paydaySnapshot,
  });
  const prev = (advice.pastPeriodViews || [])[0];
  const onTimeline = rowByStart(advice, '2026-08-14');
  ok(prev && prev.start === '2026-08-14' && prev.end === '2026-08-27',
    'newest completed period is Aug 14–27');
  ok(onTimeline === prev, 'timeline past row is the same pastPeriodViews object');
  ok(onTimeline && onTimeline.timelineRole === 'past' && onTimeline.evidenceState === 'historical',
    'that row is historical evidence');
  ok(onTimeline && onTimeline.liveCurrentBalance == null,
    'completed period does not publish live Current Balance');
  // Income 4000 + 2000 + observed gift 50 = 6050.
  // Bill load is the represented once bill 80. The recurring 120 is inside
  // the dated opening at print, so the incumbent load does not deduct it
  // again; historical sealing then shows it as planned.
  // Household budget hold is the observed grocery actual 40, not the 200 plan.
  // BAD = 6050 − 80 − 40 = 5930.
  ok(near(prev.incomeTotal, 6050), 'completed income is 6050', String(prev && prev.incomeTotal));
  ok(near(prev.periodBillLoad, 80), 'completed bill load is the represented 80',
    String(prev && prev.periodBillLoad));
  ok(near(prev.budgetHold, 40), 'completed household budget is observed spent 40',
    String(prev && prev.budgetHold));
  ok(near(prev.balanceAfterDeductions, 5930), 'completed BAD is 5930',
    String(prev && prev.balanceAfterDeductions));
  const recur = (prev.bills || []).find(b => b && b.id === 'bill-recur-prev');
  ok(recur && recur.status === 'planned', 'unproven recurring bill stays planned');
}

console.log('\n=== 7. payday rollover shifts rows without a duplicate or a skip ===');
{
  const before = recommend(timelinePlan('2026-10-09'), '2026-10-09');
  const after = recommend(timelinePlan('2026-10-23'), '2026-10-23');
  const beforeCurrent = rowByRole(before, 'current');
  const beforeNext = rowByRole(before, 'next');
  const beforeFuture = (before.payPeriodViews || []).find(p => p && p.timelineRole === 'future');
  const afterPast = (after.pastPeriodViews || [])[0];
  const afterCurrent = rowByRole(after, 'current');
  const afterNext = rowByRole(after, 'next');
  ok(beforeCurrent && beforeCurrent.start === '2026-10-09', 'before current starts Oct 9');
  ok(beforeNext && beforeNext.start === '2026-10-23', 'before next starts Oct 23');
  ok(beforeFuture && beforeFuture.start === '2026-11-06', 'before first future starts Nov 6');
  ok(afterPast && afterPast.start === '2026-10-09', 'after, previous current is the newest past');
  ok(rowByStart(after, '2026-10-09') === afterPast
      && rowByStart(after, '2026-10-09').timelineRole === 'past',
    'timeline past for Oct 9 is that same past row');
  ok(afterCurrent && afterCurrent.start === '2026-10-23', 'after, previous next is current');
  ok(afterNext && afterNext.start === '2026-11-06', 'after, previous first future is next');
  function startsFrom(advice, start) {
    return (advice.payPeriodViews || []).map(p => p.start).filter(s => s >= start);
  }
  const fromBefore = startsFrom(before, '2026-10-09');
  const fromAfter = startsFrom(after, '2026-10-09');
  ok(fromBefore.join(',') === fromAfter.join(','),
    'starts from Oct 9 through the horizon do not duplicate or skip',
    fromBefore.join(',') + ' vs ' + fromAfter.join(','));
  function contiguous(advice) {
    const starts = (advice.payPeriodViews || []).map(p => p.start);
    if (new Set(starts).size !== starts.length) return false;
    for (let i = 1; i < starts.length; i++) {
      if (addCalendarDays(starts[i - 1], 14) !== starts[i]) return false;
    }
    return starts.length > 1;
  }
  ok(contiguous(before) && contiguous(after),
    'both timelines are unique Seaspan starts 14 days apart');
  ok(!(after.payPeriodViews || []).some(p => p && p.start >= '2027-01-01'),
    'rollover still does not publish a 2027 cycle');
}

console.log('\n=== 8. repeated recommend is identical and does not mutate the plan ===');
{
  const plan = timelinePlan(AS_OF);
  const frozen = JSON.stringify(plan);
  const first = recommend(plan);
  const second = recommend(plan);
  ok(frozen === JSON.stringify(plan), 'recommend does not mutate the plan');
  ok(JSON.stringify(first.payPeriodViews) === JSON.stringify(second.payPeriodViews),
    'two recommends publish the same payPeriodViews');
  ok(JSON.stringify(first.payPeriodTimeline) === JSON.stringify(second.payPeriodTimeline),
    'two recommends publish the same payPeriodTimeline');
  ok(JSON.stringify(first.defaultView.calendarPeriods) === JSON.stringify(second.defaultView.calendarPeriods),
    'calendarPeriods do not accumulate');
  ok(JSON.stringify(first.nextPeriodView) === JSON.stringify(second.nextPeriodView),
    'nextPeriodView does not change across calls');
  ok(JSON.stringify(first.pastPeriodViews) === JSON.stringify(second.pastPeriodViews),
    'pastPeriodViews do not change across calls');
  ok(first.payPeriodViews.length === second.payPeriodViews.length,
    'the timeline does not grow on the second call');
}

console.log('\n=== horizon stops at the last full cycle on or before the boundary ===');
{
  const advice = recommend(timelinePlan(AS_OF));
  const timeline = advice.payPeriodTimeline;
  const futures = (advice.payPeriodViews || []).filter(p => p && p.timelineRole === 'future');
  ok(timeline.through === MODELLED_THROUGH, 'through is 2026-12-31');
  ok(timeline.incomeRegimeBoundary === MODELLED_THROUGH,
    'Dale-income authority end is the payroll-modelled boundary');
  ok(futures[futures.length - 1] && futures[futures.length - 1].end === MODELLED_THROUGH,
    'last future cycle ends on the boundary');
  ok(futures.every(p => p.end <= MODELLED_THROUGH),
    'every further cycle ends on or before the boundary');
  ok(/Payroll-modelled Dale-income authority ends 2026-12-31/.test(timeline.horizonReason),
    'horizonReason names the payroll-modelled boundary');
  ok(/2027 estimated payroll regime is unavailable/.test(timeline.horizonReason),
    'without planning assumptions the 2027 regime is unavailable');
  ok(/is not met inside this through date/.test(timeline.horizonReason),
    'horizonReason states the owner minimum is not met');
  ok(/2026 modelled net is not carried into 2027/.test(timeline.horizonReason),
    'horizonReason states the 2026 net is not carried forward');
  const extended = recommend(timelinePlan(AS_OF), AS_OF, {
    daleIncomeAuthorityEnd: '2027-12-31',
  });
  ok(extended.payPeriodTimeline.incomeRegimeBoundary === MODELLED_THROUGH
      && extended.payPeriodTimeline.through === MODELLED_THROUGH,
    'without the regime, a later requested end stays at 2026-12-31');
  ok(!(extended.payPeriodViews || []).some(p => p && p.start >= '2027-01-01'),
    'requesting 2027 does not publish a 2027 cycle when the regime is unavailable');
  const shortened = recommend(timelinePlan(AS_OF), AS_OF, {
    daleIncomeAuthorityEnd: '2026-11-05',
  });
  ok(shortened.payPeriodTimeline.through === '2026-11-05',
    'an earlier authority end is the through date');
  ok((shortened.payPeriodViews || []).filter(p => p && p.timelineRole === 'future').length === 0,
    'no partial cycle is added past that earlier end');
  ok(rowByRole(shortened, 'next') && rowByRole(shortened, 'next').end === '2026-11-05',
    'the incumbent next period remains even when it ends on the boundary');
  const early = recommend(timelinePlan('2026-08-14'), '2026-08-14');
  const earlyFutures = (early.payPeriodViews || []).filter(p => p && p.timelineRole === 'future');
  ok(earlyFutures.length === 8, 'from Aug 14, eight further cycles fit inside 2026',
    'count=' + earlyFutures.length);
  ok(earlyFutures[earlyFutures.length - 1]
      && earlyFutures[earlyFutures.length - 1].end === MODELLED_THROUGH,
    'those eight end on Dec 31');
  ok(/meets the owner minimum/.test(early.payPeriodTimeline.horizonReason)
      && !/is not met until/.test(early.payPeriodTimeline.horizonReason),
    'when eight cycles fit, the reason does not claim the minimum is unmet');
}

console.log('\n=== unavailable operating plan nulls timeline operating-cash claims ===');
{
  const advice = recommend(timelinePlan(AS_OF), AS_OF, { operatingPlan: 'unavailable' });
  const rows = advice.payPeriodViews || [];
  ok(rows.length > 2, 'unavailable plan still publishes the timeline');
  ok(rows.every(p => p && p.operatingCashExplanation == null),
    'every timeline row\'s operating-cash explanation is null');
  ok(advice.defaultView && advice.defaultView.operatingCashExplanation == null,
    'defaultView operating-cash explanation is null');
}

console.log('\n=== timeline source does not read Road Ahead ===');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'forecast.js'), 'utf8');
  function body(name, nextName) {
    const start = src.indexOf('function ' + name);
    const end = src.indexOf('function ' + nextName);
    if (start < 0 || end < start) return '';
    return src.slice(start, end);
  }
  const windows = body('timelinePayPeriodWindows', 'completedPayPeriodWindows');
  const compose = body('composePayPeriodTimeline', 'attachPaydayCarryover');
  const bound = body('payPeriodTimelineBound', 'payPeriodTimelineHorizonReason');
  const regime = body('timelineEstimatedDaleRegime', 'payPeriodTimelineBound');
  const walk = body('prepareBaselineTrajectoryWalk', 'trajectoryWeakerStatus');
  const shared = body('projectedDalePayroll', 'normalSpendingCoverageUsable');
  ok(windows && compose && bound && regime && walk && shared, 'timeline helpers are present');
  const blob = windows + compose + bound + regime;
  ok(!/baselineTrajectory|stage3|month-close|monthClose/.test(blob),
    'timeline windows, bound, composer, and regime stamp do not read Road Ahead values');
  ok(/projectedDalePayroll\(/.test(regime),
    'future/projected rows consume the shared projected Dale payroll source');
  ok(!/daleEstimatedPayrollDeposits\(/.test(regime),
    'the timeline does not call the statutory calculator beside that source');
  ok(/projectedDalePayroll\(/.test(walk),
    'the trajectory walk consumes the same projected Dale payroll source');
  ok(!/daleEstimatedPayrollDeposits\(/.test(walk),
    'the walk does not call the statutory calculator beside that source');
  ok(/daleEstimatedPayrollDeposits\(/.test(shared) && typeof F.projectedDalePayroll === 'function',
    'projectedDalePayroll is the exported wrapper around the one calculator');
}

console.log('\n=== 2027 estimated regime on future/projected rows ===');
{
  // First 2027 Seaspan regular, deposit-year CPP/EI restart, annual 158091:
  //   gross 6080.42, pension 364.83, tax 1413.30, CPP 353.78, EI 99.11
  //   net 6080.42 − 1413.30 − 353.78 − 99.11 − 364.83 = 3849.40
  // February bonus is 18% of 158091 = 28456.38 gross. After four identical
  // regulars the bonus net is 14717.64 (tax 11581.75, CPP 1693.15, EI 463.84).
  const DALE_2027 = 3849.40;
  const BONUS_2027 = 14717.64;
  const assumptions = {
    salaryRaiseFactor: 1.04,
    bonusRate: 0.18,
    authorizedThroughYear: 2027,
  };
  function withRegime(asOf) {
    const plan = timelinePlan(asOf);
    plan.payrollPlanningAssumptions = assumptions;
    return plan;
  }
  const forbidden = /received|relied-upon|provider/i;
  function daleRows(period) {
    return ((period && period.income) || []).filter(r => r && (r.id === 'payroll' || r.id === 'payrollBonus'));
  }

  const oct = recommend(withRegime(AS_OF));
  const current = rowByRole(oct, 'current');
  const next = rowByRole(oct, 'next');
  ok(current === oct.defaultView.calendarPeriods[0],
    'regime plan current is still calendarPeriods[0]');
  ok(next === oct.defaultView.calendarPeriods[1],
    'regime plan next is still calendarPeriods[1]');
  expectPeriod(current, CURRENT, 'regime current');
  expectPeriod(next, NEXT, 'regime next');
  ok(daleRows(current).every(r => r.amount === DALE && !r.incomeRegime),
    'current Dale row stays the 2026 fixture amount');
  ok(daleRows(next).every(r => r.amount === DALE && !r.incomeRegime),
    'Budget next Dale row stays the 2026 fixture amount');

  const dec = rowByStart(oct, '2026-12-18');
  const jan = rowByStart(oct, '2027-01-01');
  ok(dec && dec.timelineRole === 'future', 'Dec 18–31 is a further-future row');
  ok(jan && jan.timelineRole === 'future', 'Jan 1–14 is a further-future row');
  const decDale = incomeOn(dec, 'payroll', '2026-12-18');
  ok(decDale.length === 1 && decDale[0].amount === DALE && !decDale[0].incomeRegime,
    'the December 2026 pay stays the fixture amount', decDale[0] && String(decDale[0].amount));
  expectPeriod(dec, {
    start: '2026-12-18', end: '2026-12-31',
    income: 6000, bills: 0, hold: holdFor(0), bad: 5650,
  }, 'Dec 18 boundary');
  const janDale = incomeOn(jan, 'payroll', '2027-01-01');
  ok(janDale.length === 1 && janDale[0].amount === DALE_2027,
    'the January 2027 pay is the estimated net', janDale[0] && String(janDale[0].amount));
  ok(janDale[0] && janDale[0].amount !== DALE && janDale[0].amount !== 4264,
    'January does not carry 4000 or 4264');
  const janIncome = roundCent(DALE_2027);
  const janBills = roundCent(MORTGAGE + HYDRO);
  const janHold = holdFor(PETS);
  const janBad = roundCent(janIncome - janBills - janHold);
  ok(janBad === 1600.40, 'hand BAD for Jan 1–14 is 1600.40', String(janBad));
  expectPeriod(jan, {
    start: '2027-01-01', end: '2027-01-14',
    income: janIncome, bills: janBills, hold: janHold, bad: janBad,
  }, 'Jan 1 estimated');
  ok(budgetItem(jan, 'pets') && near(budgetItem(jan, 'pets').planned, PETS),
    'January dog food lands on the first Seaspan start');
  ok(billOn(jan, 'mortgage', '2027-01-01').length === 1
      && billOn(jan, 'hydro', '2027-01-03').length === 1,
    'January mortgage and hydro land once in Jan 1–14');
  ok(billOn(dec, 'mortgage', '2027-01-01').length === 0,
    'January mortgage is not also in the December period');

  const labelled = (oct.payPeriodViews || []).filter(p => p && p.timelineRole === 'future');
  let estimatedRows = 0;
  for (const period of labelled) {
    for (const row of daleRows(period)) {
      if (!row.date || row.date < '2027-01-01') continue;
      estimatedRows += 1;
      const mark = [row.status, row.settlement, row.confidence, row.incomeRegime].join(' ');
      ok(row.confidence === 'estimated' && row.status === 'estimated'
          && row.incomeRegime === '2027-estimated' && row.settlement === 'estimated',
        row.date + ' Dale row is marked estimated', mark);
      ok(!forbidden.test(mark), row.date + ' has no received, relied-upon, or provider language', mark);
      ok(row.amount !== DALE && row.amount !== 4264,
        row.date + ' is not the carried 2026 net', String(row.amount));
    }
  }
  ok(estimatedRows > 0, 'at least one 2027 Dale row is labelled', 'count=' + estimatedRows);

  const bonusHits = [];
  for (const period of oct.payPeriodViews || []) {
    for (const row of (period.income || [])) {
      if (row && (row.id === 'payrollBonus' || row.date === '2027-02-25')) {
        bonusHits.push({ start: period.start, row });
      }
    }
  }
  ok(bonusHits.length === 1 && bonusHits[0].start === '2027-02-12'
      && bonusHits[0].row.amount === BONUS_2027
      && bonusHits[0].row.incomeRegime === '2027-estimated',
    'the February bonus is in Feb 12–25 once',
    bonusHits.map(h => h.start + ':' + (h.row && h.row.amount)).join(','));
  const feb = rowByStart(oct, '2027-02-12');
  const febRegular = incomeOn(feb, 'payroll', '2027-02-12');
  ok(febRegular.length === 1 && febRegular[0].amount === DALE_2027,
    'Feb 12 regular is still the pre-anniversary estimated net');
  const febIncome = roundCent(DALE_2027 + BONUS_2027 + AMANDA_15 + CHILD);
  const febHold = holdFor(PETS);
  const febBad = roundCent(febIncome - 0 - febHold);
  ok(febBad === 20617.04, 'hand BAD for the bonus period is 20617.04', String(febBad));
  expectPeriod(feb, {
    start: '2027-02-12', end: '2027-02-25',
    income: febIncome, bills: 0, hold: febHold, bad: febBad,
  }, 'Feb 12 bonus period');
  ok(feb && feb.evidenceState === 'projected' && feb.liveCurrentBalance == null,
    'the bonus period invents no live Current Balance');
  ok((feb.householdBudget || []).every(item => item && item.spent == null),
    'the bonus period invents no household spent');

  const rolled = recommend(withRegime('2026-12-18'), '2026-12-18');
  const rolledCurrent = rowByRole(rolled, 'current');
  const rolledNext = rowByRole(rolled, 'next');
  const rolledFuture = rowByStart(rolled, '2027-01-15');
  ok(rolledCurrent && rolledCurrent.start === '2026-12-18'
      && incomeOn(rolledCurrent, 'payroll', '2026-12-18')[0].amount === DALE,
    'when December is current, its Dale pay stays the fixture amount');
  ok(rolledNext && rolledNext.id === 'next-pay-period'
      && rolledNext === rolled.defaultView.calendarPeriods[1]
      && incomeOn(rolledNext, 'payroll', '2027-01-01')[0].amount === DALE_2027
      && incomeOn(rolledNext, 'payroll', '2027-01-01')[0].incomeRegime === '2027-estimated',
    'Budget next uses the January estimate, not the 2026 net');
  ok(rolledFuture && rolledFuture.timelineRole === 'future'
      && incomeOn(rolledFuture, 'payroll', '2027-01-15')[0].amount === DALE_2027
      && incomeOn(rolledFuture, 'payroll', '2027-01-15')[0].incomeRegime === '2027-estimated',
    'the following future row uses the January estimate');

  const sep = recommend(withRegime('2026-09-25'), '2026-09-25');
  const sepTimeline = sep.payPeriodTimeline;
  const sepFutures = (sep.payPeriodViews || []).filter(p => p && p.timelineRole === 'future');
  const eighth = rowByStart(sep, '2027-01-29');
  ok(sepTimeline.incomeRegimeBoundary === MODELLED_THROUGH,
    'incomeRegimeBoundary stays 2026-12-31');
  ok(sepTimeline.through === '2027-09-24',
    'from Sep 25 the knowledge horizon binds through', sepTimeline.through);
  ok(/binding boundary is the knowledge horizon/.test(sepTimeline.horizonReason),
    'horizonReason names the knowledge horizon');
  ok(/2027 estimated payroll regime through 2027-12-31/.test(sepTimeline.horizonReason),
    'horizonReason names the estimated-regime end');
  ok(eighth && eighth.end === '2027-02-11' && eighth.timelineRole === 'future',
    'next+8 reaches Jan 29–Feb 11 2027');
  ok(sepFutures.length >= 8, 'at least eight further future rows are published',
    'count=' + sepFutures.length);
  ok(sepFutures.every(p => p.end <= sepTimeline.through),
    'every further cycle ends on or before through');
  ok(/meets the owner minimum/.test(sepTimeline.horizonReason),
    'Sep 25 meets the owner minimum');
  const starts = (sep.payPeriodViews || []).map(p => p.start);
  ok(new Set(starts).size === starts.length, 'Sep 25 timeline starts do not duplicate');
  console.log('  future-row count from 2026-09-25: ' + sepFutures.length
    + '; through ' + sepTimeline.through
    + '; boundary ' + sepTimeline.incomeRegimeBoundary);

  const capped = recommend(withRegime(AS_OF), AS_OF, {
    daleIncomeAuthorityEnd: '2028-06-30',
  });
  ok(capped.payPeriodTimeline.through === '2027-10-08',
    'a later requested end cannot pass the knowledge horizon',
    capped.payPeriodTimeline.through);
  ok(!(capped.payPeriodViews || []).some(p => p && p.start >= '2028-01-01'),
    '2028 cycles stay unpublished');
}

console.log('\n=== Jan 1–14 stays estimated as future, next, and current until evidence ===');
{
  // First 2027 regular, deposit-year CPP/EI restart, annual 158091:
  //   gross 6080.42 − tax 1413.30 − CPP 353.78 − EI 99.11 − pension 364.83
  //   = 3849.40. Not the fixture 4000 and not the 2026 post-max 4264.
  const DALE_2027 = 3849.40;
  const assumptions = {
    salaryRaiseFactor: 1.04,
    bonusRate: 0.18,
    authorizedThroughYear: 2027,
  };
  function withRegime(asOf) {
    const plan = timelinePlan(asOf);
    plan.payrollPlanningAssumptions = assumptions;
    return plan;
  }

  // Jan 1–14 income is Dale only, 3849.40, in every role before evidence.
  // Bills: mortgage Jan 1 1600 + hydro Jan 3 199 = 1799
  // Hold: groceries 200 + dale-guilt-free 150 + pets 100
  //   (first Seaspan start of January) = 450
  // BAD: 3849.40 − 1799 − 450 = 1600.40
  function janFace(period) {
    const row = incomeOn(period, 'payroll', '2027-01-01')[0];
    return row
      ? [row.status, row.settlement, row.confidence, row.incomeRegime].join(' ')
      : '';
  }
  const janIncome = roundCent(DALE_2027);
  const janBills = roundCent(MORTGAGE + HYDRO);
  const janHold = holdFor(PETS);
  const janBad = roundCent(janIncome - janBills - janHold);
  ok(janBad === 1600.40, 'hand BAD for unevidenced Jan 1–14 is 1600.40', String(janBad));
  const janSpec = {
    start: '2027-01-01', end: '2027-01-14',
    income: janIncome, bills: janBills, hold: janHold, bad: janBad,
  };

  const asFuture = recommend(withRegime('2026-12-04'), '2026-12-04');
  const futureJan = rowByStart(asFuture, '2027-01-01');
  ok(futureJan && futureJan.timelineRole === 'future'
      && futureJan.start === '2027-01-01' && futureJan.end === '2027-01-14',
    'as of Dec 4, Jan 1–14 is a further-future row');
  const futureDale = incomeOn(futureJan, 'payroll', '2027-01-01');
  ok(futureDale.length === 1 && futureDale[0].amount === DALE_2027
      && janFace(futureJan) === 'estimated estimated estimated 2027-estimated',
    'Jan 1 as future uses the estimated net', janFace(futureJan));
  expectPeriod(futureJan, janSpec, 'Jan 1 as future');

  // ATLAS-026 provenance: an invalid adjustment on the Jan 1 payroll
  // occurrence is superseded by the authoritative regime replacement —
  // the replacement supplies the basis and the period publishes exactly
  // as the no-adjustment control. An invalid adjustment the replacement
  // does not qualify for (Amanda's Jan 15 occurrence) still withholds.
  for (const [label, adjAmount] of [["string '250'", '250'], ['boolean true', true]]) {
    const adjAdvice = recommend(withRegime('2026-12-04'), '2026-12-04', {
      incomeOccurrenceAdjust: (s, d) => s && s.id === 'payroll' && d === '2027-01-01'
        ? { amount: adjAmount, confidence: 'confirmed' } : null,
    });
    const adjJan = rowByStart(adjAdvice, '2027-01-01');
    const adjDale = incomeOn(adjJan, 'payroll', '2027-01-01');
    ok(adjDale.length === 1 && adjDale[0].amount === DALE_2027
        && adjDale[0].incomeRegime === '2027-estimated'
        && adjJan.incomeTrust === 'estimated' && !adjJan.incomeUnavailableReason,
      `026 provenance regime replacement ${label}: valid replacement supplies the basis`,
      adjJan && `${adjJan.incomeTotal}/${adjJan.incomeTrust}`);
    expectPeriod(adjJan, janSpec, `Jan 1 regime replacement over ${label}`);
  }
  const unqualified = recommend(withRegime('2026-12-04'), '2026-12-04', {
    incomeOccurrenceAdjust: (s, d) => s && s.id === 'amandaSalary15' && d === '2027-01-15'
      ? { amount: '250', confidence: 'confirmed' } : null,
  });
  const unqualifiedJan = rowByStart(unqualified, '2027-01-15');
  ok(unqualifiedJan && unqualifiedJan.incomeTotal === null
      && unqualifiedJan.incomeTrust === 'unavailable'
      && typeof unqualifiedJan.incomeUnavailableReason === 'string',
    '026 provenance regime unqualified control: no replacement qualifies, period still withholds',
    unqualifiedJan && `${unqualifiedJan.incomeTotal}/${unqualifiedJan.incomeTrust}`);

  const asNext = recommend(withRegime('2026-12-18'), '2026-12-18');
  const next = rowByRole(asNext, 'next');
  const currentOnDec = rowByRole(asNext, 'current');
  ok(currentOnDec && currentOnDec.start === '2026-12-18'
      && incomeOn(currentOnDec, 'payroll', '2026-12-18')[0].amount === DALE
      && !incomeOn(currentOnDec, 'payroll', '2026-12-18')[0].incomeRegime,
    'Dec 18 as current keeps the 2026 fixture Dale amount');
  ok(next && next.id === 'next-pay-period'
      && next === asNext.defaultView.calendarPeriods[1]
      && next.start === '2027-01-01' && next.end === '2027-01-14',
    'Jan 1–14 is Budget Next Pay Period on Dec 18');
  const nextDale = incomeOn(next, 'payroll', '2027-01-01');
  ok(nextDale.length === 1 && nextDale[0].amount === DALE_2027
      && nextDale[0].incomeRegime === '2027-estimated'
      && nextDale[0].confidence === 'estimated'
      && nextDale[0].status === 'estimated'
      && nextDale[0].settlement === 'estimated',
    'Jan 1 as next uses the estimated CPP/EI-reset net',
    nextDale[0] && String(nextDale[0].amount));
  ok(nextDale[0] && nextDale[0].amount !== DALE && nextDale[0].amount !== 4264,
    'Jan 1 as next does not carry 4000 or 4264');
  ok(janFace(next) === 'estimated estimated estimated 2027-estimated'
      && !/arriving|received|relied-upon|provider/i.test(janFace(next)),
    'Jan 1 as next has no arriving, received, or relied-upon language', janFace(next));
  expectPeriod(next, janSpec, 'Jan 1 as next');

  // Jan 1 2027 as-of, before any deposit: the same window is current and
  // still the estimate. BAD stays 1600.40. Not the fixture 4000 (BAD 1751).
  const preCash = 500;
  const beforePlan = withRegime('2026-12-31');
  beforePlan.startingCash.breakdown[0].value = preCash;
  const asCurrent = recommend(beforePlan, '2027-01-01');
  const nowCurrent = rowByRole(asCurrent, 'current');
  const nowNext = rowByRole(asCurrent, 'next');
  ok(nowCurrent && nowCurrent.id === 'this-pay-period'
      && nowCurrent.start === '2027-01-01',
    'Jan 1–14 is current on Jan 1');
  const currentDale = incomeOn(nowCurrent, 'payroll', '2027-01-01');
  ok(currentDale.length === 1 && currentDale[0].amount === DALE_2027
      && janFace(nowCurrent) === 'estimated estimated estimated 2027-estimated',
    'Jan 1 as current stays the estimate before evidence',
    janFace(nowCurrent) + ' amount=' + (currentDale[0] && currentDale[0].amount));
  ok(!/arriving|received|relied-upon|provider/i.test(janFace(nowCurrent)),
    'Jan 1 as current has no relied-upon or provider language', janFace(nowCurrent));
  expectPeriod(nowCurrent, janSpec, 'Jan 1 as current before evidence');
  const publication = asCurrent.paydayAllocation && asCurrent.paydayAllocation.currentBalancePublication;
  const balanceWithEstimate = roundCent(preCash + DALE_2027);
  ok(balanceWithEstimate === 4349.40, 'hand Current Balance is 500 + 3849.40 = 4349.40',
    String(balanceWithEstimate));
  ok(publication && publication.status === 'planned-dale-payday'
      && publication.providerConfirmed === false
      && near(publication.assumedDalePayroll, DALE_2027)
      && near(publication.amount, balanceWithEstimate)
      && near(asCurrent.paydayAllocation.liveCurrentBalance, balanceWithEstimate)
      && near(asCurrent.paydayAllocation.available, balanceWithEstimate)
      && !/provider-verified|verified/i.test(publication.note || ''),
    'payday Current Balance adds the same estimate once and stays unconfirmed',
    publication && [publication.status, publication.assumedDalePayroll, publication.amount, publication.note].join(' / '));
  ok(!near(publication && publication.amount, roundCent(preCash + DALE))
      && !near(publication && publication.amount, roundCent(balanceWithEstimate + DALE_2027)),
    'Current Balance is not the 2026 amount and does not add the estimate twice');
  const incomplete = recommend(beforePlan, '2027-01-01', {
    currentPeriodActuals: {
      schema: 'atlas-current-period-actuals/v1',
      observationAsOf: '2027-01-01',
      coverageStart: '2026-12-01',
      coverageThrough: '2026-12-31',
      pendingCoverage: 'complete', transactionCoverage: 'complete',
      transactions: [{
        id: 'ambiguous-inflow', date: '2027-01-01', amount: -2500, pending: false,
        accountRole: 'household-cash', atlasAccountId: 'chequing-a',
      }],
    },
  });
  const closed = incomplete.paydayAllocation && incomplete.paydayAllocation.currentBalancePublication;
  ok(closed && closed.amount == null && closed.status === 'unavailable'
      && !near(closed.amount, balanceWithEstimate),
    'an uncovered payday inflow still fails closed and does not publish the estimate on top',
    closed && closed.status);
  ok(nowNext && nowNext.id === 'next-pay-period' && nowNext.start === '2027-01-15',
    'Jan 15–28 is next on Jan 1');
  const laterDale = incomeOn(nowNext, 'payroll', '2027-01-15');
  ok(laterDale.length === 1 && laterDale[0].amount === DALE_2027
      && laterDale[0].incomeRegime === '2027-estimated',
    'Jan 15 as next uses the estimate');

  // After the deposit: observed actual 4100, not 3849.40 and not 4000.
  // Counted once. BAD 4100 − 1799 − 450 = 1851.
  const ACTUAL = 4100;
  const afterPlan = withRegime('2027-01-01');
  afterPlan.startingCash.breakdown[0].value = ACTUAL;
  afterPlan.opening.representedEvents = [{ id: 'payroll', date: '2027-01-01' }];
  const afterBad = roundCent(ACTUAL - janBills - janHold);
  ok(afterBad === 1851, 'hand BAD after the actual deposit is 4100 − 1799 − 450 = 1851',
    String(afterBad));
  const after = recommend(afterPlan, '2027-01-01', {
    representedEvents: [{ id: 'payroll', date: '2027-01-01' }],
    currentPeriodActuals: {
      schema: 'atlas-current-period-actuals/v1',
      observationAsOf: '2027-01-01',
      coverageStart: '2027-01-01',
      coverageThrough: '2027-01-01',
      pendingCoverage: 'complete', transactionCoverage: 'complete',
      transactions: [],
      representedActuals: [{ id: 'payroll', date: '2027-01-01', actual: ACTUAL }],
    },
  });
  const afterCurrent = rowByRole(after, 'current');
  const afterDale = incomeOn(afterCurrent, 'payroll', '2027-01-01');
  ok(afterDale.length === 1 && near(afterDale[0].amount, ACTUAL)
      && afterDale[0].amount !== DALE_2027 && !afterDale[0].incomeRegime,
    'the observed deposit replaces the estimate once',
    afterDale.map(r => r.amount + '/' + r.incomeRegime).join(','));
  expectPeriod(afterCurrent, {
    start: '2027-01-01', end: '2027-01-14',
    income: ACTUAL, bills: janBills, hold: janHold, bad: afterBad,
  }, 'Jan 1 after the actual deposit');
  const afterPub = after.paydayAllocation && after.paydayAllocation.currentBalancePublication;
  ok(afterPub && near(afterPub.amount, ACTUAL) && afterPub.assumedDalePayroll == null
      && !near(afterPub.amount, roundCent(ACTUAL + DALE_2027))
      && !near(afterCurrent.incomeTotal, roundCent(ACTUAL + DALE_2027)),
    'Current Balance and period income do not add the estimate on top of the actual',
    afterPub && String(afterPub.amount));

  const bare = recommend(timelinePlan('2027-01-01'), '2027-01-01');
  const bareCurrent = rowByRole(bare, 'current');
  const bareNext = rowByRole(bare, 'next');
  ok(incomeOn(bareCurrent, 'payroll', '2027-01-01')[0].amount === DALE
      && !incomeOn(bareCurrent, 'payroll', '2027-01-01')[0].incomeRegime
      && incomeOn(bareNext, 'payroll', '2027-01-15')[0].amount === DALE
      && !(bare.payPeriodViews || []).some(p => p && p.timelineRole === 'future' && p.start >= '2027-01-01'),
    'without planning assumptions, current and next keep the incumbent amount and further 2027 rows are omitted');
}

console.log('\n=== Jan 2 date-passed payroll stays the 2027 estimate until real evidence ===');
{
  // Same hand arithmetic as the unevidenced Jan 1–14 row:
  //   3849.40 − (1600 + 199) − 450 = 1600.40
  // Passing Jan 1 is not an observed actual, a represented key, or an
  // amount. The calendar printer may still mark the row received /
  // alreadyInCash / opening because the date is before the cash snapshot.
  const DALE_2027 = 3849.40;
  const assumptions = {
    salaryRaiseFactor: 1.04,
    bonusRate: 0.18,
    authorizedThroughYear: 2027,
  };
  function withRegime(asOf, openingExtra) {
    const plan = timelinePlan(asOf);
    plan.payrollPlanningAssumptions = assumptions;
    if (openingExtra) Object.assign(plan.opening, openingExtra);
    return plan;
  }
  function janFace(period) {
    const row = incomeOn(period, 'payroll', '2027-01-01')[0];
    return row
      ? [row.status, row.settlement, row.confidence, row.incomeRegime].join(' ')
      : '';
  }
  const janIncome = roundCent(DALE_2027);
  const janBills = roundCent(MORTGAGE + HYDRO);
  const janHold = holdFor(PETS);
  const janBad = roundCent(janIncome - janBills - janHold);
  ok(janBad === 1600.40, 'hand BAD for unevidenced Jan 1–14 is 1600.40', String(janBad));
  const janSpec = {
    start: '2027-01-01', end: '2027-01-14',
    income: janIncome, bills: janBills, hold: janHold, bad: janBad,
  };
  const face = 'estimated estimated estimated 2027-estimated';

  // Case 1 — Jan 1, opening still the day before, no evidence.
  const jan1Plan = withRegime('2026-12-31');
  jan1Plan.startingCash.breakdown[0].value = 500;
  const jan1 = recommend(jan1Plan, '2027-01-01');
  const jan1Current = rowByRole(jan1, 'current');
  ok(jan1Current && jan1Current.start === '2027-01-01'
      && incomeOn(jan1Current, 'payroll', '2027-01-01').length === 1
      && incomeOn(jan1Current, 'payroll', '2027-01-01')[0].amount === DALE_2027
      && janFace(jan1Current) === face,
    'Jan 1 before evidence stays the estimate', janFace(jan1Current));
  expectPeriod(jan1Current, janSpec, 'Jan 1 before evidence');

  // Case 2 — Jan 2, payroll date has passed, still no evidence.
  // Opening stays Dec 31, so the bill load is unchanged. As-of alone
  // must not revive the fixture amount.
  const jan2Plan = withRegime('2026-12-31');
  jan2Plan.startingCash.breakdown[0].value = 500;
  const jan2 = recommend(jan2Plan, '2027-01-02');
  const jan2Current = rowByRole(jan2, 'current');
  const jan2Dale = incomeOn(jan2Current, 'payroll', '2027-01-01');
  ok(jan2Current && jan2Current.start === '2027-01-01'
      && jan2Dale.length === 1
      && jan2Dale[0].amount === DALE_2027
      && jan2Dale[0].amount !== DALE
      && jan2Dale[0].amount !== 4264
      && janFace(jan2Current) === face,
    'Jan 2 after the date passed still uses the estimate',
    janFace(jan2Current) + ' amount=' + (jan2Dale[0] && jan2Dale[0].amount));
  expectPeriod(jan2Current, janSpec, 'Jan 2 with no evidence');
  const jan2Pub = jan2.paydayAllocation && jan2.paydayAllocation.currentBalancePublication;
  ok(jan2Pub && jan2Pub.status !== 'planned-dale-payday'
      && !near(jan2Current.incomeTotal, roundCent(DALE_2027 + DALE))
      && !near(jan2Current.incomeTotal, roundCent(DALE_2027 + 4264)),
    'Jan 2 current-period income does not add a stale payroll beside the estimate',
    jan2Pub && jan2Pub.status);

  // The same Jan 2 with the cash snapshot moved onto that day and no
  // prior boundary. The printer's inside/date-passed path would otherwise
  // keep the fixture net. It must not.
  const snapped = withRegime('2027-01-02');
  snapped.startingCash.breakdown[0].value = 500;
  const snappedAdvice = recommend(snapped, '2027-01-02');
  const snappedCurrent = rowByRole(snappedAdvice, 'current');
  const snappedDale = incomeOn(snappedCurrent, 'payroll', '2027-01-01');
  ok(snappedDale.length === 1
      && snappedDale[0].amount === DALE_2027
      && snappedDale[0].amount !== DALE
      && snappedDale[0].amount !== 4264
      && janFace(snappedCurrent) === face
      && snappedDale[0].alreadyInCash === false,
    'a cash snapshot after Jan 1 without evidence does not restore the 2026 net',
    janFace(snappedCurrent) + ' amount=' + (snappedDale[0] && snappedDale[0].amount));
  ok(near(snappedCurrent.incomeTotal, DALE_2027)
      && near(snappedCurrent.balanceAfterDeductions,
        roundCent(DALE_2027 - snappedCurrent.periodBillLoad - snappedCurrent.budgetHold)),
    'Jan 2 snapshot Budget identity stays income − incumbent bills − hold');

  // Case 3 — real evidence on Jan 2 replaces the estimate once.
  // priorAsOf keeps the Jan 1 key inside the incumbent represented window.
  const ACTUAL = 4100;
  const evidenced = withRegime('2027-01-02', {
    priorAsOf: '2026-12-31',
    representedEvents: [{ id: 'payroll', date: '2027-01-01' }],
  });
  evidenced.startingCash.breakdown[0].value = ACTUAL;
  const afterBad = roundCent(ACTUAL - janBills - janHold);
  ok(afterBad === 1851, 'hand BAD after the Jan 2 actual is 4100 − 1799 − 450 = 1851',
    String(afterBad));
  const after = recommend(evidenced, '2027-01-02', {
    representedEvents: [{ id: 'payroll', date: '2027-01-01' }],
    currentPeriodActuals: {
      schema: 'atlas-current-period-actuals/v1',
      observationAsOf: '2027-01-02',
      coverageStart: '2027-01-01',
      coverageThrough: '2027-01-02',
      pendingCoverage: 'complete', transactionCoverage: 'complete',
      transactions: [],
      representedActuals: [{ id: 'payroll', date: '2027-01-01', actual: ACTUAL }],
    },
  });
  const afterCurrent = rowByRole(after, 'current');
  const afterDale = incomeOn(afterCurrent, 'payroll', '2027-01-01');
  ok(afterDale.length === 1 && near(afterDale[0].amount, ACTUAL)
      && afterDale[0].amount !== DALE_2027 && !afterDale[0].incomeRegime,
    'Jan 2 observed actual replaces the estimate once',
    afterDale.map(r => r.amount + '/' + (r.incomeRegime || 'none')).join(','));
  expectPeriod(afterCurrent, {
    start: '2027-01-01', end: '2027-01-14',
    income: ACTUAL, bills: janBills, hold: janHold, bad: afterBad,
  }, 'Jan 2 after the actual deposit');
  ok(!near(afterCurrent.incomeTotal, roundCent(ACTUAL + DALE_2027)),
    'Jan 2 does not count the actual and the estimate');
}

console.log('\n=== trajectory and timeline share one projected Dale payroll ===');
{
  const DALE_2027 = 3849.40;
  const BONUS_2027 = 14717.64;
  const plan = {
    windowDays: 91,
    startingCash: { amount: 2500 },
    defaults: { targetBuffer: 200, extraDebtMonthly: 0, scenario: 'expected' },
    budget: {
      basis: 'ytd',
      categories: [{
        id: 'groceries', label: 'Groceries', class: 'essential',
        from: ['Groceries'], plannedWeekly: 140,
      }],
    },
    obligations: [],
    bills: [],
    commitments: [],
    income: [{
      id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
      anchor: ANCHOR, amount: 4264, confidence: 'confirmed',
    }],
    payrollPlanningAssumptions: {
      salaryRaiseFactor: 1.04,
      bonusRate: 0.18,
      authorizedThroughYear: 2027,
    },
  };
  const periods = {
    periods: {
      ytd: { label: 'YTD', months: 1, spending: [{ label: 'Groceries', total: 1000 }] },
    },
  };
  const projected = F.projectedDalePayroll(plan, '2026-08-19', '2027-08-18', { asOf: '2026-08-19' });
  const janDeposits = (projected.deposits || []).filter(d => d && d.date && d.date.slice(0, 7) === '2027-01');
  const febDeposits = (projected.deposits || []).filter(d => d && d.date && d.date.slice(0, 7) === '2027-02');
  const bonus = (projected.deposits || []).filter(d => d && d.kind === 'bonus' && d.date === '2027-02-25');
  ok(projected.status === 'ready', 'projected Dale payroll is ready');
  ok(janDeposits.length === 3 && janDeposits.every(d => d.kind === 'regular' && d.net === DALE_2027),
    'January 2027 projected regulars are three deposits of 3849.40',
    janDeposits.map(d => d.date + ':' + d.net).join(','));
  ok(bonus.length === 1 && bonus[0].net === BONUS_2027,
    'the February bonus is projected once at 14717.64');
  const janNet = roundCent(janDeposits.reduce((s, d) => s + d.net, 0));
  const febNet = roundCent(febDeposits.reduce((s, d) => s + d.net, 0));
  ok(janNet === 11548.20, 'hand January projected net is 3 × 3849.40 = 11548.20', String(janNet));
  ok(febNet === 22416.44, 'hand February projected net is 3849.40 + 3849.40 + 14717.64 = 22416.44',
    String(febNet));
  const settled = F.projectedDalePayroll(plan, '2027-01-01', '2027-01-31', {
    asOf: '2027-01-01',
    representedEvents: [{ id: 'payroll', date: '2027-01-01' }],
  });
  ok(settled.regime && (settled.regime.deposits || []).some(d => d.date === '2027-01-01' && d.kind === 'regular'),
    'the calculator still emits the represented January cheque');
  ok(!(settled.deposits || []).some(d => d.date === '2027-01-01'),
    'the shared source omits a cheque already represented on asOf');
  const traj = F.baselineTrajectory(plan, [], '2026-08-19', { periods });
  const jan = (traj.months || []).find(m => m && m.month === '2027-01');
  const feb = (traj.months || []).find(m => m && m.month === '2027-02');
  ok(traj.status === 'ready' && jan && jan.income && jan.income.status === 'estimated'
      && jan.income.amount === janNet,
    'Road Ahead January income equals the shared projected source',
    jan && jan.income && String(jan.income.amount));
  ok(feb && feb.income && feb.income.amount === febNet,
    'Road Ahead February income equals the shared projected source, bonus once',
    feb && feb.income && String(feb.income.amount));
}

// ATLAS-026: a scheduled receipt with a missing amount must not publish as
// calculated zero in the period view. Synthetic Grok-shaped fixture: payday
// snapshot opening 50, biweekly payroll of genuine zero, one-off receipt on
// 2026-10-16, one 120 bill on 2026-10-20. The 2026-10-16 period is the first
// period whose income identity relies on the receipt.
function sectionMissingIncomeAmount() {
  const ASOF = '2026-10-07';
  const fixture = (income, openingExtra) => ({
    windowDays: 120,
    defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
    opening: Object.assign({
      asOf: ASOF,
      paydaySnapshot: { periodStart: '2026-10-02', asOf: '2026-10-02', opening: 50 },
      representedEvents: [{ id: 'payroll', date: '2026-10-02' }],
    }, openingExtra || {}),
    startingCash: { breakdown: [{ id: 'chequing-a', value: 50 }] },
    income,
    bills: [{ id: 'b1', label: 'Synthetic bill', frequency: 'once', date: '2026-10-20', amount: 120, confidence: 'confirmed' }],
    obligations: [], commitments: [], budget: { categories: [] },
  });
  const payroll = { id: 'payroll', frequency: 'biweekly', anchor: '2026-10-02', amount: 0, confidence: 'confirmed' };
  const receipt = amount => ({ id: 'r1', label: 'Synthetic receipt', frequency: 'once', date: '2026-10-16', amount, confidence: 'confirmed' });
  const run = (plan, opts) => F.recommend(plan, ASOF, Object.assign({ weeklyVariable: 0, debts: [] }, opts || {}));

  // Missing amount: every dependent figure is withheld as unknown, with the
  // income-unavailable reason published; the known opening stock and the
  // already-withheld sweep stay exactly as they were.
  const missing = rowByStart(run(fixture([payroll, receipt(null)])), '2026-10-16');
  ok(!!missing, '026 missing: period exists');
  if (missing) {
    ok(missing.incomeTotal === null, '026 missing: incomeTotal unknown, not zero', String(missing.incomeTotal));
    ok(missing.incomeTrust === 'unavailable', '026 missing: incomeTrust unavailable', String(missing.incomeTrust));
    ok(typeof missing.incomeUnavailableReason === 'string' && missing.incomeUnavailableReason.includes('income-unavailable'),
      '026 missing: income-unavailable reason published', String(missing.incomeUnavailableReason));
    ok(missing.available === null, '026 missing: payday balance unknown', String(missing.available));
    ok(missing.afterBills === null && missing.afterBillsTrust === 'unavailable',
      '026 missing: after-bills unknown', `${missing.afterBills}/${missing.afterBillsTrust}`);
    ok(missing.balanceAfterDeductions === null && missing.balanceAfterDeductionsTrust === 'unavailable',
      '026 missing: balance after deductions unknown',
      `${missing.balanceAfterDeductions}/${missing.balanceAfterDeductionsTrust}`);
    ok(missing.predictedEndingBalance === null && missing.predictedEndingBalanceTerms === null,
      '026 missing: predicted ending withheld with its terms',
      `${missing.predictedEndingBalance}/${JSON.stringify(missing.predictedEndingBalanceTerms)}`);
    ok(missing.paydaySweep === null, '026 missing: payday sweep remains withheld', String(missing.paydaySweep));
    ok(missing.openingKnown === true && near(missing.opening, 50),
      '026 missing: known opening stock preserved', `${missing.openingKnown}/${missing.opening}`);
  }
  // The period before the receipt is unaffected.
  const missingPrior = rowByStart(run(fixture([payroll, receipt(null)])), '2026-10-02');
  ok(missingPrior && missingPrior.incomeTotal === 0 && missingPrior.incomeTrust === 'calculated'
      && !missingPrior.incomeUnavailableReason,
    '026 missing: prior period unaffected',
    missingPrior && `${missingPrior.incomeTotal}/${missingPrior.incomeTrust}/${missingPrior.incomeUnavailableReason}`);

  // Genuine zero stays a trusted zero (positive control for the detector).
  const zero = rowByStart(run(fixture([payroll, receipt(0)])), '2026-10-16');
  ok(zero && zero.incomeTotal === 0 && zero.incomeTrust === 'calculated' && !zero.incomeUnavailableReason
      && near(zero.afterBills, -120) && near(zero.balanceAfterDeductions, -120)
      && near(zero.predictedEndingBalance, -120) && zero.predictedEndingBalanceTerms
      && zero.predictedEndingBalanceTerms.closes === true,
    '026 zero control: genuine zero publishes as calculated zero',
    zero && `${zero.incomeTotal}/${zero.incomeTrust}/${zero.afterBills}/${zero.balanceAfterDeductions}`);

  // Positive receipt publishes normally.
  const positive = rowByStart(run(fixture([payroll, receipt(500)])), '2026-10-16');
  ok(positive && near(positive.incomeTotal, 500) && positive.incomeTrust === 'calculated'
      && !positive.incomeUnavailableReason && near(positive.afterBills, 380)
      && near(positive.predictedEndingBalance, 380) && positive.predictedEndingBalanceTerms
      && positive.predictedEndingBalanceTerms.closes === true,
    '026 positive control: valid receipt publishes normally',
    positive && `${positive.incomeTotal}/${positive.afterBills}/${positive.predictedEndingBalance}`);

  // Mixed known + unknown receipts in one period: the total is withheld
  // (never a partial sum published as complete); the known row still shows.
  const mixed = rowByStart(run(fixture([payroll, receipt(null),
    { id: 'r2', label: 'Known receipt', frequency: 'once', date: '2026-10-18', amount: 500, confidence: 'confirmed' }])),
    '2026-10-16');
  ok(mixed && mixed.incomeTotal === null && mixed.incomeTrust === 'unavailable'
      && typeof mixed.incomeUnavailableReason === 'string'
      && (mixed.income || []).some(r => r && r.id === 'r2' && near(r.amount, 500)),
    '026 mixed: total withheld, known receipt row preserved',
    mixed && `${mixed.incomeTotal}/${mixed.incomeTrust}/${(mixed.income || []).length}`);

  // Effective-basis controls: a raw missing plan amount with a valid
  // effective basis must NOT taint the period.
  const scenario = rowByStart(run(fixture([payroll,
    { id: 'r1', label: 'Monthly receipt', frequency: 'monthly', day: 16, firstDue: '2026-10-16', amount: null, scenarioMonthly: { expected: 500 }, confidence: 'confirmed' }])),
    '2026-10-16');
  ok(scenario && near(scenario.incomeTotal, 500) && scenario.incomeTrust === 'calculated'
      && !scenario.incomeUnavailableReason,
    '026 scenario control: scenarioMonthly basis keeps the period known',
    scenario && `${scenario.incomeTotal}/${scenario.incomeTrust}`);
  const override = rowByStart(run(fixture([payroll,
    { id: 'r1', label: 'Override receipt', frequency: 'biweekly', anchor: '2026-10-16', amount: null, confidence: 'confirmed' }]),
    { incomeOverrides: { r1: 2600 } }), '2026-10-16');
  ok(override && near(override.incomeTotal, 1200) && override.incomeTrust === 'calculated'
      && !override.incomeUnavailableReason,
    '026 override control: incomeOverrides basis keeps the period known',
    override && `${override.incomeTotal}/${override.incomeTrust}`);

  // Qualified exclusions follow the incumbent selectors, not raw list
  // membership. A same-day not-relied-upon entry (the selector qualifies
  // date === asOf) excludes its receipt: no taint.
  const notRelied = rowByStart(run(fixture([payroll,
    { id: 'r1', label: 'Synthetic receipt', frequency: 'once', date: '2026-10-07', amount: null, confidence: 'confirmed' }],
    { notReliedUponEvents: [{ id: 'r1', date: '2026-10-07', reason: 'already in cash' }] })), '2026-10-02');
  ok(notRelied && notRelied.incomeTotal === 0 && notRelied.incomeTrust === 'calculated'
      && !notRelied.incomeUnavailableReason,
    '026 qualified not-relied control: same-day exclusion does not taint',
    notRelied && `${notRelied.incomeTotal}/${notRelied.incomeTrust}/${notRelied.incomeUnavailableReason}`);
  // Negative: a FUTURE-dated not-relied-upon entry is not qualified by the
  // incumbent selector, so it excludes nothing — the hold must fire.
  const futureNotRelied = rowByStart(run(fixture([payroll, receipt(null)],
    { notReliedUponEvents: [{ id: 'r1', date: '2026-10-16', reason: 'already in cash' }] })), '2026-10-16');
  ok(futureNotRelied && futureNotRelied.incomeTotal === null && futureNotRelied.incomeTrust === 'unavailable'
      && typeof futureNotRelied.incomeUnavailableReason === 'string',
    '026 unqualified not-relied negative: future-dated entry does not suppress the hold',
    futureNotRelied && `${futureNotRelied.incomeTotal}/${futureNotRelied.incomeTrust}`);
  // Negative: a represented entry for a future occurrence is likewise not
  // qualified at this asOf (stale effective date), so it excludes nothing.
  const futureRepresented = rowByStart(run(fixture([payroll, receipt(null)],
    { representedEvents: [{ id: 'payroll', date: '2026-10-02' }, { id: 'r1', date: '2026-10-16' }] })), '2026-10-16');
  ok(futureRepresented && futureRepresented.incomeTotal === null && futureRepresented.incomeTrust === 'unavailable'
      && typeof futureRepresented.incomeUnavailableReason === 'string',
    '026 unqualified represented negative: future represented entry does not suppress the hold',
    futureRepresented && `${futureRepresented.incomeTotal}/${futureRepresented.incomeTrust}`);
  // Occurrence adjustments are an effective basis: a positive adjustment
  // publishes its amount; a declared-zero adjustment keeps the period a
  // known zero. Neither may be flagged unknown.
  const adjPositive = rowByStart(run(fixture([payroll, receipt(null)]),
    { incomeOccurrenceAdjust: (s) => s && s.id === 'r1' ? { amount: 300, confidence: 'confirmed' } : null }), '2026-10-16');
  ok(adjPositive && near(adjPositive.incomeTotal, 300) && adjPositive.incomeTrust === 'calculated'
      && !adjPositive.incomeUnavailableReason,
    '026 adjustment control: positive occurrence adjustment is the effective basis',
    adjPositive && `${adjPositive.incomeTotal}/${adjPositive.incomeTrust}`);
  const adjZero = rowByStart(run(fixture([payroll, receipt(null)]),
    { incomeOccurrenceAdjust: (s) => s && s.id === 'r1' ? { amount: 0, confidence: 'confirmed' } : null }), '2026-10-16');
  ok(adjZero && adjZero.incomeTotal === 0 && adjZero.incomeTrust === 'calculated'
      && !adjZero.incomeUnavailableReason && near(adjZero.afterBills, -120),
    '026 adjustment control: declared-zero occurrence adjustment stays a known zero',
    adjZero && `${adjZero.incomeTotal}/${adjZero.incomeTrust}/${adjZero.incomeUnavailableReason}`);
  // An omitted occurrence is a declared non-event (expandEvents drops it
  // entirely): it must not taint the period.
  const adjOmit = rowByStart(run(fixture([payroll, receipt(null)]),
    { incomeOccurrenceAdjust: (s) => s && s.id === 'r1' ? { omit: true } : null }), '2026-10-16');
  ok(adjOmit && adjOmit.incomeTotal === 0 && adjOmit.incomeTrust === 'calculated'
      && !adjOmit.incomeUnavailableReason && near(adjOmit.afterBills, -120),
    '026 adjustment control: omitted occurrence does not taint',
    adjOmit && `${adjOmit.incomeTotal}/${adjOmit.incomeTrust}/${adjOmit.incomeUnavailableReason}`);
  // A negative adjustment is not a valid income basis anywhere in the
  // codebase: it disposes of nothing, so the hold must fire.
  const adjNegative = rowByStart(run(fixture([payroll, receipt(null)]),
    { incomeOccurrenceAdjust: (s) => s && s.id === 'r1' ? { amount: -300, confidence: 'confirmed' } : null }), '2026-10-16');
  ok(adjNegative && adjNegative.incomeTotal === null && adjNegative.incomeTrust === 'unavailable'
      && typeof adjNegative.incomeUnavailableReason === 'string' && adjNegative.afterBills === null,
    '026 adjustment negative: negative adjustment is no basis, hold fires',
    adjNegative && `${adjNegative.incomeTotal}/${adjNegative.incomeTrust}/${adjNegative.incomeUnavailableReason}`);
  // Follow-up: the same invalid negative adjustment on a KNOWN receipt
  // discards the occurrence in expandEvents and the period publishes a
  // calculated zero — the known amount silently vanishes. The hold must
  // fire with the same qualification and reason.
  const knownAdjNegative = rowByStart(run(fixture([payroll, receipt(500)]),
    { incomeOccurrenceAdjust: (s) => s && s.id === 'r1' ? { amount: -300, confidence: 'confirmed' } : null }), '2026-10-16');
  ok(knownAdjNegative && knownAdjNegative.incomeTotal === null && knownAdjNegative.incomeTrust === 'unavailable'
      && typeof knownAdjNegative.incomeUnavailableReason === 'string'
      && knownAdjNegative.afterBills === null && knownAdjNegative.predictedEndingBalance === null,
    '026 known-receipt negative adjustment: known amount discarded by an invalid adjustment withholds the period',
    knownAdjNegative && `${knownAdjNegative.incomeTotal}/${knownAdjNegative.incomeTrust}/${knownAdjNegative.incomeUnavailableReason}`);
  // Uniform rule: a native genuine zero with a negative adjustment is the
  // same invalid declaration — the negative disposes of nothing there too.
  const zeroAdjNegative = rowByStart(run(fixture([payroll, receipt(0)]),
    { incomeOccurrenceAdjust: (s) => s && s.id === 'r1' ? { amount: -300, confidence: 'confirmed' } : null }), '2026-10-16');
  ok(zeroAdjNegative && zeroAdjNegative.incomeTotal === null && zeroAdjNegative.incomeTrust === 'unavailable'
      && typeof zeroAdjNegative.incomeUnavailableReason === 'string',
    '026 zero-receipt negative adjustment: invalid declaration withholds under the uniform rule',
    zeroAdjNegative && `${zeroAdjNegative.incomeTotal}/${zeroAdjNegative.incomeTrust}`);
  // Omit still takes precedence over a negative amount: a declared
  // non-event on a known receipt stays a known zero.
  const knownOmitNegative = rowByStart(run(fixture([payroll, receipt(500)]),
    { incomeOccurrenceAdjust: (s) => s && s.id === 'r1' ? { omit: true, amount: -300 } : null }), '2026-10-16');
  ok(knownOmitNegative && knownOmitNegative.incomeTotal === 0 && knownOmitNegative.incomeTrust === 'calculated'
      && !knownOmitNegative.incomeUnavailableReason && near(knownOmitNegative.afterBills, -120),
    '026 known-receipt omit control: omission precedence over a negative amount is preserved',
    knownOmitNegative && `${knownOmitNegative.incomeTotal}/${knownOmitNegative.incomeTrust}`);
  // A qualified exclusion still governs: a same-day not-relied-upon known
  // receipt with a negative adjustment does not taint its period.
  const knownExcludedNegative = rowByStart(run(fixture([payroll,
    { id: 'r1', label: 'Synthetic receipt', frequency: 'once', date: '2026-10-07', amount: 500, confidence: 'confirmed' }],
    { notReliedUponEvents: [{ id: 'r1', date: '2026-10-07', reason: 'already in cash' }] },
    ), { incomeOccurrenceAdjust: (s) => s && s.id === 'r1' ? { amount: -300, confidence: 'confirmed' } : null }), '2026-10-02');
  ok(knownExcludedNegative && knownExcludedNegative.incomeTotal === 0
      && knownExcludedNegative.incomeTrust === 'calculated' && !knownExcludedNegative.incomeUnavailableReason,
    '026 known-receipt excluded negative control: qualified exclusion still governs',
    knownExcludedNegative && `${knownExcludedNegative.incomeTotal}/${knownExcludedNegative.incomeTrust}`);
  // Residual: an adjustment amount that is not a finite number is the same
  // invalid declaration on a known receipt — non-finite values and numeric
  // strings drop in expandEvents/sections and publish a calculated zero,
  // and non-numeric types are coerced into figures no validator accepts.
  // Only a finite non-negative number (or omit, or no amount) disposes.
  const adjInvalidCases = [
    ['-Infinity', { amount: -Infinity, confidence: 'confirmed' }],
    ['NaN', { amount: NaN, confidence: 'confirmed' }],
    ["string '-250'", { amount: '-250', confidence: 'confirmed' }],
  ];
  for (const [label, adj] of adjInvalidCases) {
    const v = rowByStart(run(fixture([payroll, receipt(500)]),
      { incomeOccurrenceAdjust: (s) => s && s.id === 'r1' ? adj : null }), '2026-10-16');
    ok(v && v.incomeTotal === null && v.incomeTrust === 'unavailable'
        && typeof v.incomeUnavailableReason === 'string' && v.afterBills === null,
      `026 invalid adjustment ${label}: declared non-basis amount withholds the period`,
      v && `${v.incomeTotal}/${v.incomeTrust}`);
  }
  // +Infinity already withholds on the incumbent code (the row survives
  // with a null amount); pin it so the generalization cannot regress it.
  const adjPosInfinity = rowByStart(run(fixture([payroll, receipt(500)]),
    { incomeOccurrenceAdjust: (s) => s && s.id === 'r1' ? { amount: Infinity, confidence: 'confirmed' } : null }), '2026-10-16');
  ok(adjPosInfinity && adjPosInfinity.incomeTotal === null && adjPosInfinity.incomeTrust === 'unavailable',
    '026 invalid adjustment +Infinity control: incumbent withholding preserved',
    adjPosInfinity && `${adjPosInfinity.incomeTotal}/${adjPosInfinity.incomeTrust}`);
  // An adjustment declaring no amount leaves the native amount standing.
  const adjNoAmount = rowByStart(run(fixture([payroll, receipt(500)]),
    { incomeOccurrenceAdjust: (s) => s && s.id === 'r1' ? { amount: null, confidence: 'confirmed' } : null }), '2026-10-16');
  ok(adjNoAmount && adjNoAmount.incomeTotal === 500 && adjNoAmount.incomeTrust === 'calculated'
      && !adjNoAmount.incomeUnavailableReason,
    '026 adjustment no-amount control: native amount stands',
    adjNoAmount && `${adjNoAmount.incomeTotal}/${adjNoAmount.incomeTrust}`);
  // Provenance repair: a non-number adjustment amount is substituted
  // verbatim into the event and calendarIncomeRowFromEvent coerces it
  // into a genuine-looking row basis (roundCent does Number(...)), so the
  // period publishes the coerced figure. The substituted event's invalid
  // source must not gain a numeric contribution; independent actuals and
  // conversions keep theirs.
  for (const [label, adjAmount] of [["string '250'", '250'], ['boolean true', true]]) {
    for (const [nativeLabel, nativeAmount] of [['positive', 500], ['zero', 0]]) {
      const v = rowByStart(run(fixture([payroll, receipt(nativeAmount)]),
        { incomeOccurrenceAdjust: (s) => s && s.id === 'r1' ? { amount: adjAmount, confidence: 'confirmed' } : null }), '2026-10-16');
      ok(v && v.incomeTotal === null && v.incomeTrust === 'unavailable'
          && typeof v.incomeUnavailableReason === 'string' && v.afterBills === null,
        `026 provenance ${label} on ${nativeLabel} native: coerced contribution withheld`,
        v && `${v.incomeTotal}/${v.incomeTrust}`);
    }
    const missing = rowByStart(run(fixture([payroll, receipt(null)]),
      { incomeOccurrenceAdjust: (s) => s && s.id === 'r1' ? { amount: adjAmount, confidence: 'confirmed' } : null }), '2026-10-16');
    ok(missing && missing.incomeTotal === null && missing.incomeTrust === 'unavailable',
      `026 provenance ${label} on missing native: coerced row also covers the missing-native arm, withheld`,
      missing && `${missing.incomeTotal}/${missing.incomeTrust}`);
  }
  // A qualified actual establishes the contribution independently of the
  // invalid substituted amount: positive and zero actuals both publish.
  const actualPacket = (actual) => ({
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: AS_OF,
    coverageStart: '2026-10-02',
    coverageThrough: AS_OF,
    pendingCoverage: 'complete', transactionCoverage: 'complete',
    transactions: [],
    representedActuals: [{ id: 'r1', date: '2026-10-07', actual }],
  });
  for (const [label, actual] of [['positive', 450], ['zero', 0]]) {
    const v = rowByStart(run(fixture([payroll,
      { id: 'r1', label: 'Synthetic receipt', frequency: 'once', date: '2026-10-07', amount: 500, confidence: 'confirmed' }],
      { representedEvents: [{ id: 'r1', date: '2026-10-07' }] }),
      { incomeOccurrenceAdjust: (s) => s && s.id === 'r1' ? { amount: '250', confidence: 'confirmed' } : null,
        currentPeriodActuals: actualPacket(actual) }), '2026-10-02');
    ok(v && v.incomeTotal === actual && v.incomeTrust === 'calculated' && !v.incomeUnavailableReason,
      `026 provenance actual ${label} preserved: qualified actual publishes over an invalid adjustment`,
      v && `${v.incomeTotal}/${v.incomeTrust}`);
  }
  // #723 gap (5) disposition: this was the ATLAS-026 scope pin that kept a
  // sealed lookback publishing the coerced figure (250 / 1) as calculated.
  // Engine classification 6524178220 superseded it: a sealed period applies
  // the same unknown-amount detection, so the marked occurrence withholds
  // the period exactly as it does in the active period above.
  for (const [label, adjAmount] of [["string '250'", '250'], ['boolean true', true]]) {
    const sealedPlan = fixture([payroll,
      { id: 'r1', label: 'Synthetic receipt', frequency: 'once', date: '2026-09-25', amount: 500, confidence: 'confirmed' }]);
    const v = rowByStart(run(sealedPlan,
      { incomeOccurrenceAdjust: (s) => s && s.id === 'r1' ? { amount: adjAmount, confidence: 'confirmed' } : null }), '2026-09-18');
    ok(v && v.incomeTotal === null && v.incomeTrust === 'unavailable'
        && String(v.incomeUnavailableReason || '').includes('income-unavailable') && v.afterBills === null,
      `026 provenance sealed lookback ${label}: coerced contribution withheld (gap 5)`,
      v && `${v.incomeTotal}/${v.incomeTrust}`);
  }
  // Disabled-stream provenance hold: an unresolved marked row holds its
  // period even where each incumbent detector arm skips it — the row arm
  // excludes Other Income rows and both stream arms exclude disabled
  // ids, so a disabled Other Income stream with an invalid adjustment
  // otherwise publishes a zero total for an unknown amount.
  for (const [label, adjAmount] of [["string '250'", '250'], ['boolean true', true]]) {
    const disabledOpts = { disabled: ['r1'],
      incomeOccurrenceAdjust: (s) => s && s.id === 'r1' ? { amount: adjAmount, confidence: 'confirmed' } : null };
    const ordDisabled = rowByStart(run(fixture([payroll,
      { id: 'r1', label: 'Synthetic receipt', frequency: 'once', date: '2026-10-20', amount: 500, confidence: 'confirmed' }]),
      disabledOpts), '2026-10-16');
    ok(ordDisabled && ordDisabled.incomeTotal === null && ordDisabled.incomeTrust === 'unavailable'
        && typeof ordDisabled.incomeUnavailableReason === 'string',
      `026 provenance disabled ordinary ${label}: unresolved marked row holds the period`,
      ordDisabled && `${ordDisabled.incomeTotal}/${ordDisabled.incomeTrust}`);
    const otherDisabled = rowByStart(run(fixture([payroll,
      { id: 'r1', label: 'Synthetic receipt', frequency: 'once', date: '2026-10-20', amount: 500, confidence: 'confirmed', incomeClass: 'other' }]),
      disabledOpts), '2026-10-16');
    ok(otherDisabled && otherDisabled.incomeTotal === null && otherDisabled.incomeTrust === 'unavailable'
        && typeof otherDisabled.incomeUnavailableReason === 'string',
      `026 provenance disabled other-income ${label}: false zero withheld, period holds`,
      otherDisabled && `${otherDisabled.incomeTotal}/${otherDisabled.incomeTrust}`);
  }
  // A disabled Other Income stream with no adjustment keeps its
  // incumbent publication: the hold is provenance-specific.
  const disabledNoAdj = rowByStart(run(fixture([payroll,
    { id: 'r1', label: 'Synthetic receipt', frequency: 'once', date: '2026-10-20', amount: 500, confidence: 'confirmed', incomeClass: 'other' }]),
    { disabled: ['r1'] }), '2026-10-16');
  ok(disabledNoAdj && disabledNoAdj.incomeTotal === 500 && disabledNoAdj.incomeTrust === 'calculated'
      && !disabledNoAdj.incomeUnavailableReason,
    '026 provenance disabled no-adjustment control: incumbent publication unchanged',
    disabledNoAdj && `${disabledNoAdj.incomeTotal}/${disabledNoAdj.incomeTrust}`);
  // A native string amount with no adjustment keeps its incumbent
  // (coerced) publication: the repair is adjustment-specific.
  const nativeString = rowByStart(run(fixture([payroll, receipt('500')])), '2026-10-16');
  ok(nativeString && nativeString.incomeTotal === 500 && nativeString.incomeTrust === 'calculated'
      && !nativeString.incomeUnavailableReason,
    '026 provenance native-string control: no-replacement native conversion unchanged',
    nativeString && `${nativeString.incomeTotal}/${nativeString.incomeTrust}`);
  // An independent additional-income event keeps its explicit conversion
  // in its own period while the adjusted receipt's period withholds.
  const independentRun = run(fixture([payroll, receipt(500)]),
    { incomeOccurrenceAdjust: (s) => s && s.id === 'r1' ? { amount: '250', confidence: 'confirmed' } : null,
      additionalIncomeEvents: [{ id: 'x1', kind: 'income', date: '2026-11-20', amount: '250' }] });
  const independentWithheld = rowByStart(independentRun, '2026-10-16');
  const independentLater = rowByStart(independentRun, '2026-11-13');
  ok(independentWithheld && independentWithheld.incomeTotal === null
      && independentWithheld.incomeTrust === 'unavailable'
      && independentLater && independentLater.incomeTotal === 250
      && independentLater.incomeTrust === 'estimated',
    '026 provenance independent replacement: additional-income conversion preserved while the defect period withholds',
    `${independentWithheld && independentWithheld.incomeTotal}/${independentLater && independentLater.incomeTotal}`);

  // A missing-amount receipt with no contributing occurrence in a period
  // leaves that period known; only its own period goes unknown.
  const latePlan = fixture([payroll,
    { id: 'r1', label: 'Late receipt', frequency: 'once', date: '2026-11-20', amount: null, confidence: 'confirmed' }]);
  const lateAdvice = run(latePlan);
  const lateEarly = rowByStart(lateAdvice, '2026-10-16');
  const lateOwn = rowByStart(lateAdvice, '2026-11-13');
  ok(lateEarly && lateEarly.incomeTotal === 0 && lateEarly.incomeTrust === 'calculated'
      && !lateEarly.incomeUnavailableReason,
    '026 occurrence control: no contributing occurrence, no taint',
    lateEarly && `${lateEarly.incomeTotal}/${lateEarly.incomeTrust}`);
  ok(lateOwn && lateOwn.incomeTotal === null && lateOwn.incomeTrust === 'unavailable'
      && typeof lateOwn.incomeUnavailableReason === 'string',
    '026 occurrence control: the receipt\'s own period is unknown',
    lateOwn && `${lateOwn.incomeTotal}/${lateOwn.incomeTrust}`);
}
sectionMissingIncomeAmount();

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
