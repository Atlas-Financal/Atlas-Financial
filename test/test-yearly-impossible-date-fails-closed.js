'use strict';
/* H2-12 (Gemini hunt 2, #821 7091517953): a yearly obligation or income on a
 * day its month never has (April 31, February 30 or 31, June 31) has no real
 * date. For any window its own schedule (firstDue, lastDue) would reach, it is
 * a scheduled-amount unknown (plan-date-invalid) that withholds what depends
 * on it, never quietly paid or received on the month's last day. An ended or
 * not-yet-started row changes nothing, as on main (ChatGPT 7098708528).
 * Yearly bills are unchanged here: undated bills have no window bound yet
 * (NEXT PR). February 29 is a real day and unchanged.
 *
 * Failure it detects: an impossible yearly obligation or income reaching the
 * window while the plan reads ready; an ended or future one withholding today's
 * plan; a real yearly date (Feb 29, Apr 30, Dec 31) being flagged.
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

console.log('\n=== 2. a yearly bill is unchanged here (NEXT PR) ===');
{
  // Undated bills have no window bound yet (billNeedsDate is window-free and has many readers), so marking an
  // ended bill undated would withhold today's figures. Yearly bills keep main's behaviour in this PR.
  const bill = yearly('bad', 4, 31, 50);
  ok(F.billNeedsDate(bill) === false && JSON.stringify(F.occurrences(bill, AS_OF, '2027-12-31')) === JSON.stringify(['2027-04-30']),
    'yearly bill 4/31: unchanged from main in this PR (the bill case is the NEXT PR)', JSON.stringify(F.occurrences(bill, AS_OF, '2027-12-31')));
}

console.log('\n=== 3. an impossible yearly obligation withholds the plan, never vanishes ===');
for (const [month, day] of IMPOSSIBLE) {
  const g = read(plan(p => { p.obligations.push(yearly('policy', month, day, 300)); }));
  ok(g.status === 'unavailable' && g.unknowns.some(u => u.carrier === 'obligation' && u.id === 'policy' && u.reason === 'plan-date-invalid'),
    `yearly obligation ${month}/${day}: scheduled amounts unavailable, the obligation named plan-date-invalid`, JSON.stringify(g.unknowns));
  ok(g.r.weekly == null, `yearly obligation ${month}/${day}: the weekly spending figure is withheld`);
  ok(/day its month never has/.test((g.r.scheduledAmounts && g.r.scheduledAmounts.reason) || ''),
    `yearly obligation ${month}/${day}: the published reason names the impossible day`, g.r.scheduledAmounts && g.r.scheduledAmounts.reason);
}

console.log('\n=== 3b. what is withheld follows the schedule\'s reach ===');
{
  // Nov 31 would have fallen on Nov 30 2026, inside the forecast walk: every figure that depends on it is unknown.
  const near = read(plan(p => { p.obligations.push(yearly('policy', 11, 31, 300)); }));
  ok(near.cur.balanceAfterDeductions === null && near.next.balanceAfterDeductions === null && near.r.sim.ending == null,
    'yearly obligation 11/31 (would-be Nov 30, in the walk): Balance After Deductions and the projected walk are unknown, never read as if the payment were absent');
  // Apr 31 would have fallen in April 2027, beyond the two pay periods shown: those periods do not depend on it and stay known.
  const far = read(plan(p => { p.obligations.push(yearly('policy', 4, 31, 300)); }));
  ok(far.status === 'unavailable' && far.cur.balanceAfterDeductions === 1210 && far.next.balanceAfterDeductions === 1300,
    'yearly obligation 4/31 (would-be April 2027): flagged, while this and next pay period (1,210 and 1,300 by hand: 1,400 - 90 - 100; 1,400 - 100) stay known',
    JSON.stringify([far.status, far.cur.balanceAfterDeductions, far.next.balanceAfterDeductions]));
}

console.log('\n=== 3c. a statement-replaced obligation keeps main\'s statement path, beside the withhold ===');
{
  // An invented yearly card payment on Nov 31 with one statement record for its 2026 occurrence (scheduled on
  // Nov 30 by the recurring clamp, due Nov 27, minimum 250) and an unreadable fallback amount for later years.
  // On main: the 2026 occurrence is the statement's (Nov 27, 250, confirmed); the 2027 one falls back to the row
  // ('tbd', estimated) and is the incumbent scheduled-amount unknown. Both stay exactly so; plan-date-invalid is added.
  const ob = { id: 'policy', label: 'Invented policy', debtId: 'inv-debt', effect: 'payment', frequency: 'yearly', month: 11, day: 31,
    amount: 'tbd', confidence: 'estimated',
    statementOccurrences: [{ scheduledDate: '2026-11-30', dueDate: '2026-11-27', minimum: 250, currency: 'cad', confidence: 'confirmed' }] };
  const occ = F.obligationOccurrences(ob, AS_OF, '2027-12-31').map(o => [o.scheduledDate, o.date, o.amount, o.statement, o.confidence]);
  ok(JSON.stringify(occ) === JSON.stringify([['2026-11-30', '2026-11-27', 250, true, 'confirmed'], ['2027-11-30', '2027-11-30', 'tbd', false, 'estimated']]),
    'statement path: the replaced 2026 occurrence (Nov 27, 250) and the 2027 fallback are exactly main\'s', JSON.stringify(occ));
  const st = F.scheduledAmountState(plan(p => { p.obligations.push(ob); }), AS_OF, '2027-12-31', {});
  const got = st.unknowns.filter(u => u.id === 'policy').map(u => u.reason).sort();
  ok(st.status === 'unavailable' && JSON.stringify(got) === JSON.stringify(['plan-date-invalid', 'scheduled-amount-unknown']),
    'the withhold is added beside the incumbent 2027 amount unknown, which still runs', JSON.stringify(got));
}

{
  // Statement-only control (ChatGPT 7099423097): the same yearly Nov 31 card payment, bounded to its 2026 occurrence
  // (lastDue 2026-12-31), whose one occurrence a valid statement replaces (due Nov 27, 250, confirmed). Nothing in
  // the window falls back to the impossible day, so nothing withholds: the forecast reads ready, exactly as on main
  // (hand: this period 1,210 and next 1,300, as the base plan, since the payment falls after both).
  const only = { id: 'policy', label: 'Invented policy', debtId: 'inv-debt', effect: 'payment', frequency: 'yearly', month: 11, day: 31,
    amount: 300, confidence: 'estimated', lastDue: '2026-12-31',
    statementOccurrences: [{ scheduledDate: '2026-11-30', dueDate: '2026-11-27', minimum: 250, currency: 'cad', confidence: 'confirmed' }] };
  const g = read(plan(p => { p.obligations.push(only); }));
  ok(g.status === 'ready' && g.unknowns.length === 0, 'statement-only: no unknown, the forecast reads ready', JSON.stringify(g.unknowns));
  ok(g.r.weekly != null && g.r.sim.ending != null && g.cur.balanceAfterDeductions === 1210 && g.next.balanceAfterDeductions === 1300,
    'statement-only: the weekly figure, the projected walk and both periods (1,210 and 1,300) are shown',
    JSON.stringify([g.r.weekly == null, g.r.sim.ending == null, g.cur.balanceAfterDeductions, g.next.balanceAfterDeductions]));
  const occ = F.obligationOccurrences(only, AS_OF, '2027-12-31').map(o => [o.scheduledDate, o.date, o.amount, o.statement]);
  ok(JSON.stringify(occ) === JSON.stringify([['2026-11-30', '2026-11-27', 250, true]]),
    'statement-only: the statement still resolves (Nov 27, 250), exactly as on main', JSON.stringify(occ));
}

console.log('\n=== 4. an impossible yearly income withholds the plan, never drops to $0 ===');
for (const [month, day] of IMPOSSIBLE) {
  const g = read(plan(p => { p.income.push(yearly('bonus', month, day, 500)); }));
  ok(g.status === 'unavailable' && g.unknowns.some(u => u.carrier === 'income' && u.id === 'bonus' && u.reason === 'plan-date-invalid'),
    `yearly income ${month}/${day}: scheduled amounts unavailable, the income named plan-date-invalid`, JSON.stringify(g.unknowns));
}

console.log('\n=== 4b. the row\'s own bounds decide: an ended or not-yet-started row changes nothing ===');
for (const [label, bounds] of [['ended (lastDue 2025-12-31)', { lastDue: '2025-12-31' }], ['not yet started (firstDue 2030-01-01)', { firstDue: '2030-01-01' }]]) {
  const obl = read(plan(p => { p.obligations.push({ ...yearly('policy', 4, 31, 300), ...bounds }); }));
  ok(obl.status === 'ready' && obl.unknowns.length === 0, `yearly obligation 4/31, ${label}: the plan stays ready, as on main`, JSON.stringify(obl.unknowns));
  const inc = read(plan(p => { p.income.push({ ...yearly('bonus', 2, 30, 500), ...bounds }); }));
  ok(inc.status === 'ready' && inc.unknowns.length === 0, `yearly income 2/30, ${label}: the plan stays ready, as on main`, JSON.stringify(inc.unknowns));
}
{
  // Bounds that still reach the window withhold.
  const g = read(plan(p => { p.obligations.push({ ...yearly('policy', 4, 31, 300), firstDue: '2026-01-01', lastDue: '2030-12-31' }); }));
  ok(g.status === 'unavailable' && g.unknowns.some(u => u.id === 'policy' && u.reason === 'plan-date-invalid'),
    'yearly obligation 4/31 whose bounds reach the window: withheld');
}

console.log('\n=== 5. the committed plan reads as well-formed: nothing new is flagged ===');
{
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
  const state = F.scheduledAmountState(data.plan, data.plan.opening.asOf, F.addDays(data.plan.opening.asOf, 400), {});
  ok(!state.unknowns.some(u => u.reason === 'plan-date-invalid'), 'the committed plan carries no impossible yearly date');
}

console.log(failures ? `\n${failures} failure(s)` : '\nyearly impossible date fails closed: all checks passed');
process.exit(failures ? 1 : 0);
