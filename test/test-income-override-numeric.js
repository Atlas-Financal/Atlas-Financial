'use strict';
/* #723: an income override must be a real number. Text, empty or true never
 * becomes income and never publishes as zero; it withholds as Unknown.
 *
 * Invented plan: as-of Wed 2026-10-14, biweekly pay 1,400 anchored Fri
 * 2026-10-09 (This Pay Period Oct 9 - Oct 22, Next Oct 23 - Nov 5), one
 * monthly bill of 90 on the 12th (lands only in This Pay Period).
 *
 * Hand-worked expectations (from the inputs, not from Atlas):
 *   no override:       income 1,400 each period; after bills 1,310 / 1,400.
 *   override 2,500:    a monthly figure paid bi-weekly is 26ths of a year:
 *                      2,500 x 12 / 26 = 1,153.846... -> 1,153.85 each
 *                      period; after bills 1,153.85 - 90 = 1,063.85 / 1,153.85.
 *   override 0:        income 0; after bills -90 / 0 (a declared zero stays).
 *   "2500", "", " ", true, false, [], NaN, Infinity: income and after bills
 *                      are unknown (null) in both periods.
 *   null / no entry:   no override (same as none).
 *
 * `node test/test-income-override-numeric.js`
 */
const F = require('../public/forecast.js');
let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' - ' + detail : ''}`);
};
const AS_OF = '2026-10-14';
const plan = () => ({
  defaults: { targetBuffer: 0 }, startingCash: { amount: 2000 },
  opening: { asOf: AS_OF, priorAsOf: '2026-10-09', representedEvents: [] },
  income: [{ id: 'payroll', label: 'Invented pay', frequency: 'biweekly', anchor: '2026-10-09', amount: 1400, confidence: 'confirmed' }],
  bills: [{ id: 'hydro', label: 'Invented hydro', frequency: 'monthly', day: 12, amount: 90, confidence: 'confirmed' }],
  obligations: [], commitments: [], budget: { categories: [] },
});
const periods = override => {
  const opts = { targetBuffer: 0, debts: [] };
  if (override !== undefined) opts.incomeOverrides = { payroll: override };
  const v = F.recommend(plan(), AS_OF, opts).defaultView;
  const by = id => v.calendarPeriods.find(x => x.id === id);
  return { cur: by('this-pay-period'), next: by('next-pay-period'), v };
};
const none = periods();
ok(none.cur.incomeTotal === 1400 && none.cur.afterBills === 1310 && none.next.afterBills === 1400,
  'no override: income 1,400, after bills 1,310 / 1,400');
for (const [label, value] of [['undefined entry', undefined], ['null', null]]) {
  const r = periods(value);
  ok(JSON.stringify(r.v) === JSON.stringify(none.v), `${label} is no override: figures identical to none`);
}
const num = periods(2500);
ok(num.cur.incomeTotal === 1153.85 && num.cur.afterBills === 1063.85 && num.next.afterBills === 1153.85,
  'number 2500: 2,500 x 12 / 26 = 1,153.85 income; after bills 1,063.85 / 1,153.85');
const zero = periods(0);
ok(zero.cur.incomeTotal === 0 && zero.cur.afterBills === -90 && zero.next.afterBills === 0,
  'number 0 stays a declared zero: income 0, after bills -90 / 0');
const neg = periods(-100);
ok(neg.cur.incomeTotal === null && neg.cur.afterBills === null,
  'number -100 is unchanged from before: not a valid income, so unknown');
for (const [label, value] of [['text "2500"', '2500'], ['empty ""', ''], ['blank " "', ' '],
  ['true', true], ['false', false], ['array []', []], ['NaN', NaN], ['Infinity', Infinity]]) {
  const r = periods(value);
  ok(r.cur.incomeTotal === null && r.cur.afterBills === null && r.next.incomeTotal === null && r.next.afterBills === null,
    `${label} withholds income and after bills as unknown (never income, never zero)`,
    `income=${r.cur.incomeTotal} after=${r.cur.afterBills}`);
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
