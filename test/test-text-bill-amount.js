'use strict';
/* #726: a bill amount typed as a numeric string is read as its number.
 *
 * Invented plan: as-of Wed 2026-10-14, biweekly pay 1,400 anchored Fri
 * 2026-10-09 (This Pay Period Oct 9 - Oct 22). One monthly bill on the 12th.
 *
 * Hand-worked expectations (from the inputs, not from Atlas):
 *   amount 120.5 or "120.50" or " 120.50 ": load 120.5, after bills
 *     1,400 - 120.5 = 1,279.5, forward walk ready.
 *   "12abc", "", null, NaN, true, "1,900": load, after bills unknown
 *     and the forward walk unavailable (withheld, never zero).
 *
 * `node test/test-text-bill-amount.js`
 */
const F = require('../public/forecast.js');
let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' - ' + detail : ''}`);
};
const AS_OF = '2026-10-14';
const plan = amount => ({
  defaults: { targetBuffer: 0 }, startingCash: { amount: 2000 },
  opening: { asOf: AS_OF, priorAsOf: '2026-10-09', representedEvents: [] },
  income: [{ id: 'payroll', label: 'Invented pay', frequency: 'biweekly', anchor: '2026-10-09', amount: 1400, confidence: 'confirmed' }],
  bills: [{ id: 'hydro', label: 'Invented hydro', frequency: 'monthly', day: 12, amount, confidence: 'confirmed' }],
  obligations: [], commitments: [], budget: { categories: [] },
});
const read = amount => {
  const p = plan(amount);
  const v = F.recommend(p, AS_OF, { targetBuffer: 0, debts: [] }).defaultView;
  const cur = v.calendarPeriods.find(x => x.id === 'this-pay-period');
  return { load: cur.periodBillLoad, after: cur.afterBills, walk: F.scheduledAmountState(p, AS_OF, '2027-01-12').status,
    json: JSON.stringify(v) };
};
const control = read(120.5);
ok(control.load === 120.5 && control.after === 1279.5 && control.walk === 'ready', 'number 120.5: load 120.5, after bills 1,279.5');
for (const text of ['120.50', ' 120.50 ', '120.5']) {
  const r = read(text);
  ok(r.load === 120.5 && r.after === 1279.5 && r.walk === 'ready', `text ${JSON.stringify(text)} publishes as 120.5`,
    `load=${r.load} after=${r.after}`);
}
for (const bad of ['12abc', '', null, NaN, true, '1,900']) {
  const r = read(bad);
  ok(r.load === null && r.after === null && r.walk === 'unavailable', `malformed ${JSON.stringify(bad)} still withholds`,
    `load=${r.load} after=${r.after} walk=${r.walk}`);
}
/* Byte-identical control: the numeric figures do not change. The text view
 * differs only in the echoed raw amount string, so compare the figures. */
const num = read(90).json, txt = read('90').json;
ok(num === txt.replace('"amount":"90"', '"amount":90') || JSON.parse(num).calendarPeriods
  .every((p, i) => p.periodBillLoad === JSON.parse(txt).calendarPeriods[i].periodBillLoad
    && p.afterBills === JSON.parse(txt).calendarPeriods[i].afterBills),
  'valid inputs: number 90 and text "90" give identical period figures');
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
