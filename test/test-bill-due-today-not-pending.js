'use strict';
/* A bill merely due on the as-of day has no bank evidence, so it is never
 * "pending". Pending needs a matched pending debit (#907's authority).
 *
 * Invented plan: as-of Wed 2026-10-14, biweekly pay 1,400 anchored Fri
 * 2026-10-09, one monthly bill of 90 on a chosen day, no bank transactions.
 *
 * Hand-worked expectations (from the inputs, not from Atlas):
 *   due the 13th: still due, settlement unverified (past due, unproven)
 *   due the 14th: still due, settlement upcoming  (today; main said pending)
 *   due the 15th: still due, settlement upcoming
 *   due the 14th and recorded as paid in the opening: PAID, represented
 *   period bill load and after bills are identical to a bill due the 15th
 *   (this period loads 90, after bills 1,310): the label never moves a figure.
 *
 * `node test/test-bill-due-today-not-pending.js`
 */
const F = require('../public/forecast.js');
let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' - ' + detail : ''}`);
};
const AS_OF = '2026-10-14';
const plan = (day, represented) => ({
  defaults: { targetBuffer: 0 }, startingCash: { amount: 2000 },
  opening: { asOf: AS_OF, priorAsOf: '2026-10-09', representedEvents: represented || [] },
  income: [{ id: 'payroll', label: 'Invented pay', frequency: 'biweekly', anchor: '2026-10-09', amount: 1400, confidence: 'confirmed' }],
  bills: [{ id: 'hydro', label: 'Invented hydro', frequency: 'monthly', day, amount: 90, confidence: 'confirmed' }],
  obligations: [], commitments: [], budget: { categories: [] },
});
const view = (day, represented) => F.recommend(plan(day, represented), AS_OF, { targetBuffer: 0, debts: [] }).defaultView;
const billRows = v => {
  const rows = [];
  (function walk(o, depth) {
    if (!o || depth > 6) return;
    if (Array.isArray(o)) return o.forEach(x => walk(x, depth + 1));
    if (typeof o !== 'object') return;
    if (o.id === 'hydro' && 'status' in o) rows.push({ status: o.status, settlement: o.settlement, date: o.date });
    Object.values(o).forEach(x => walk(x, depth + 1));
  })(v, 0);
  return rows;
};
const only = (rows, label) => { ok(rows.length > 0, `${label}: the bill row is published`); return rows; };
const cases = [[13, 'still due', 'unverified'], [14, 'still due', 'upcoming'], [15, 'still due', 'upcoming']];
for (const [day, status, settlement] of cases) {
  const rows = only(billRows(view(day)), `due the ${day}th`);
  ok(rows.every(r => r.status === status && r.settlement === settlement),
    `due the ${day}th reads status "${status}" / ${settlement}, never pending`,
    JSON.stringify([...new Set(rows.map(r => r.status + '|' + r.settlement))]));
}
const paid = only(billRows(view(14, [{ id: 'hydro', date: AS_OF }])), 'due today and recorded paid');
ok(paid.every(r => r.status === 'PAID' && r.settlement === 'represented'), 'control: a recorded-paid bill due today is still PAID');
const figures = day => {
  const cur = view(day).calendarPeriods.find(p => p.id === 'this-pay-period');
  return [cur.periodBillLoad, cur.afterBills];
};
ok(JSON.stringify(figures(14)) === JSON.stringify(figures(15)) && figures(14)[0] === 90 && figures(14)[1] === 1310,
  'control: due today and due tomorrow give identical period figures (load 90, after bills 1,310)');
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
