'use strict';
/* H2-12 (Gemini hunt 2, #821 7091517953): a yearly bill, obligation or income
 * on a day its month never has (April 31, February 30 or 31, June 31) has no
 * real date. It fails closed: a bill reads date-unknown (billNeedsDate, the
 * incumbent undated-bill path), an obligation or income is a scheduled-amount
 * unknown (plan-date-invalid) that withholds the plan, and occurrences gives no
 * date. Before this, each was silently moved to the month's last day.
 * February 29 is a real day and is unchanged: it recurs on February 28 in
 * common years, as before.
 *
 * Failure it detects: an impossible yearly date scheduling on another day, an
 * obligation or income on one vanishing from the figures while the plan reads
 * ready, or a real yearly date (Feb 29, Apr 30, Dec 31) being refused.
 * Release decision: any failure blocks.
 *
 * Invented world, as-of Wed 2026-10-14 (the world of
 * test-plan-input-frequency-fail-closed): biweekly pay 1,400 anchored Fri
 * 2026-10-09, hydro 90 on the 20th, one household target of 100 a payday.
 *
 *   node test/test-yearly-impossible-date-fails-closed.js
 */
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' - ' + detail : ''}`);
};
const AS_OF = '2026-10-14';
const plan = mut => {
  const p = {
    defaults: { targetBuffer: 500 }, startingCash: { amount: 5000 },
    opening: { asOf: AS_OF, priorAsOf: '2026-10-09', representedEvents: [] },
    income: [{ id: 'payroll', label: 'Invented pay', frequency: 'biweekly', anchor: '2026-10-09', amount: 1400, confidence: 'confirmed' }],
    bills: [{ id: 'hydro', label: 'Invented hydro', frequency: 'monthly', day: 20, amount: 90, confidence: 'confirmed' }],
    obligations: [],
    commitments: [],
    budget: { categories: [{ id: 'groceries', label: 'Invented groceries', plannedPayday: 100 }] },
  };
  if (mut) mut(p);
  return p;
};
const read = p => {
  const r = F.recommend(p, AS_OF, {});
  const v = r.defaultView;
  const by = id => v.calendarPeriods.find(x => x.id === id);
  return { r, cur: by('this-pay-period'), next: by('next-pay-period'),
    status: r.scheduledAmounts ? r.scheduledAmounts.status : 'ready',
    unknowns: r.scheduledAmounts ? r.scheduledAmounts.unknowns : [] };
};
const yearly = (id, month, day, amount) => ({ id, label: 'Invented yearly ' + id, frequency: 'yearly', month, day, amount, confidence: 'confirmed' });
const IMPOSSIBLE = [[4, 31], [6, 31], [9, 31], [11, 31], [2, 30], [2, 31]];

console.log('\n=== 1. controls: real yearly days are unchanged ===');
{
  const base = read(plan());
  ok(base.status === 'ready' && base.unknowns.length === 0, 'the base plan is ready with no unknown');
  for (const [month, day, want] of [[4, 30, ['2027-04-30', '2028-04-30']], [12, 31, ['2026-12-31', '2027-12-31', '2028-12-31']],
    [1, 31, ['2027-01-31', '2028-01-31']], [2, 28, ['2027-02-28', '2028-02-28']],
    ['4', '30', ['2027-04-30', '2028-04-30']]]) {
    const bill = yearly('real', month, day, 50);
    ok(F.billNeedsDate(bill) === false
      && JSON.stringify(F.occurrences(bill, AS_OF, '2028-12-31')) === JSON.stringify(want),
      `yearly ${month}/${day}: dated, on ${want.join(', ')}`, JSON.stringify(F.occurrences(bill, AS_OF, '2028-12-31')));
  }
  // February 29 is a real day: it recurs on Feb 28 in common years (unchanged).
  const leap = yearly('leap', 2, 29, 50);
  ok(F.billNeedsDate(leap) === false
    && JSON.stringify(F.occurrences(leap, AS_OF, '2028-12-31')) === JSON.stringify(['2027-02-28', '2028-02-29']),
    'yearly Feb 29: dated, on 2027-02-28 and 2028-02-29 (unchanged)', JSON.stringify(F.occurrences(leap, AS_OF, '2028-12-31')));
  const g = read(plan(p => { p.obligations.push(yearly('policy', 4, 30, 300)); p.income.push(yearly('gift', 2, 29, 200)); }));
  ok(g.status === 'ready', 'a plan with a real yearly obligation (Apr 30) and income (Feb 29) reads ready');
}

console.log('\n=== 2. an impossible yearly bill is date-unknown, never moved to another day ===');
for (const [month, day] of IMPOSSIBLE) {
  const bill = yearly('bad', month, day, 50);
  ok(F.billNeedsDate(bill) === true, `yearly bill ${month}/${day}: billNeedsDate is true (not moved to the month's last day)`);
  ok(F.occurrences(bill, AS_OF, '2028-12-31').length === 0, `yearly ${month}/${day}: occurrences gives no date`);
  const g = read(plan(p => { p.bills.push(bill); }));
  ok(g.unknowns.some(u => u.carrier === 'bill' && u.id === 'bad' && u.reason === 'bill-date-unknown'),
    `yearly bill ${month}/${day}: published as a date-unknown bill (the undated-bill path)`, JSON.stringify(g.unknowns));
}

console.log('\n=== 3. an impossible yearly obligation withholds the plan, never vanishes ===');
for (const [month, day] of IMPOSSIBLE) {
  const g = read(plan(p => { p.obligations.push(yearly('policy', month, day, 300)); }));
  ok(g.status === 'unavailable' && g.unknowns.some(u => u.carrier === 'obligation' && u.id === 'policy' && u.reason === 'plan-date-invalid'),
    `yearly obligation ${month}/${day}: scheduled amounts unavailable, the obligation named plan-date-invalid`, JSON.stringify(g.unknowns));
  ok(g.cur.balanceAfterDeductions === null && g.next.balanceAfterDeductions === null,
    `yearly obligation ${month}/${day}: Balance After Deductions is unknown, not read as if the payment were absent`);
}

console.log('\n=== 4. an impossible yearly income withholds the plan, never drops to $0 ===');
for (const [month, day] of IMPOSSIBLE) {
  const g = read(plan(p => { p.income.push(yearly('bonus', month, day, 500)); }));
  ok(g.status === 'unavailable' && g.unknowns.some(u => u.carrier === 'income' && u.id === 'bonus' && u.reason === 'plan-date-invalid'),
    `yearly income ${month}/${day}: scheduled amounts unavailable, the income named plan-date-invalid`, JSON.stringify(g.unknowns));
}

console.log('\n=== 5. the committed plan reads as well-formed: nothing new is flagged ===');
{
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
  const state = F.scheduledAmountState(data.plan, data.plan.opening.asOf, F.addDays(data.plan.opening.asOf, 400), {});
  ok(!state.unknowns.some(u => u.reason === 'plan-date-invalid'), 'the committed plan carries no impossible yearly date');
}

console.log(failures ? `\n${failures} failure(s)` : '\nyearly impossible date fails closed: all checks passed');
process.exit(failures ? 1 : 0);
