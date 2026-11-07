'use strict';
/* A6 (#726): a bill with an unknown amount or an unknown date never
 * becomes $0 or a guessed date in a household figure.
 *
 * Invented plan (no household figure): as-of Wed 2026-10-14, biweekly
 * payroll 1,400 anchored Fri 2026-10-09, so This Pay Period is
 * Oct 9 - Oct 22 and Next Pay Period is Oct 23 - Nov 5. One dated bill,
 * 90 on the 12th, lands only in This Pay Period.
 *
 * Hand-derived expectations (written from the inputs, not from Atlas):
 *   baseline: this load 90, afterBills 1,400 - 90 = 1,310;
 *             next load 0, afterBills 1,400.
 *   + amount-less once bill on Oct 28 (next period): this period stays
 *     90 / 1,310; next period load and afterBills are unknown; the row is
 *     listed with a null amount; the forward walk is unavailable.
 *   + undated 80 bill: it could land in either period, so both loads and
 *     both afterBills are unknown; it is listed as undated with amount 80
 *     (never $0), and the forward walk is unavailable.
 *   + undated 80 bill whose firstDue is Nov 10 (after Nov 5): neither
 *     window can hold it, so both stay 90 / 1,310 and 0 / 1,400.
 *   + undated, amount-less bill: listed undated with a null amount.
 *
 * Also a source guard: only billNeedsDate reads a plan bill's needsDate.
 *
 * `node test/test-a6-unknown-bill-amount-date.js`
 */
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) { failures += 1; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
  else console.log(`  PASS  ${label}`);
};
const AS_OF = '2026-10-14';

function plan(extra) {
  return {
    defaults: { targetBuffer: 0 },
    startingCash: { amount: 2000 },
    opening: { asOf: AS_OF, priorAsOf: '2026-10-09', representedEvents: [] },
    income: [{ id: 'payroll', label: 'Invented pay', frequency: 'biweekly', anchor: '2026-10-09', amount: 1400, confidence: 'confirmed' }],
    bills: [{ id: 'hydro', label: 'Invented hydro', frequency: 'monthly', day: 12, amount: 90, confidence: 'confirmed' }].concat(extra || []),
    obligations: [], commitments: [],
    budget: { categories: [] },
  };
}
function view(extra) {
  const p = plan(extra);
  const v = F.recommend(p, AS_OF, { targetBuffer: 0, debts: [] }).defaultView;
  const by = id => (v.calendarPeriods || []).find(x => x.id === id);
  return { p, v, cur: by('this-pay-period'), next: by('next-pay-period') };
}
const walkState = p => F.scheduledAmountState(p, AS_OF, '2027-01-12').status;

console.log('=== baseline (positive control) ===');
{
  const { p, cur, next } = view();
  ok(cur && cur.start === '2026-10-09' && next && next.start === '2026-10-23', 'two windows: Oct 9 and Oct 23');
  ok(cur.periodBillLoad === 90 && cur.afterBills === 1310, 'this period: load 90, after bills 1,310');
  ok(next.periodBillLoad === 0 && next.afterBills === 1400, 'next period: load 0, after bills 1,400');
  ok(walkState(p) === 'ready', 'forward walk is published');
}

console.log('=== unknown amount ===');
{
  const repair = { id: 'repair', label: 'Invented repair', frequency: 'once', date: '2026-10-28', confidence: 'estimated' };
  const { p, cur, next } = view([repair]);
  ok(cur.periodBillLoad === 90 && cur.afterBills === 1310, 'this period (does not hold it) stays 90 / 1,310');
  const row = (next.bills || []).find(r => r.id === 'repair');
  ok(row && row.date === '2026-10-28', 'the amount-less bill is listed on its date');
  ok(row && row.amount === null && row.planned === null && row.movement === null && row.remaining === null,
    'its amount, planned, movement and remaining are null, not 0');
  ok(next.periodBillLoad === null && next.afterBills === null, 'next period load and after bills are unknown');
  ok(next.totalBillsThisPeriod === null && next.remainingBills === null, 'next period bill totals are unknown');
  ok(walkState(p) === 'unavailable', 'forward walk is withheld');
}

console.log('=== unknown date ===');
for (const [label, bill] of [
  ['once with no date', { id: 'licence', label: 'Invented licence', frequency: 'once', amount: 80, confidence: 'estimated' }],
  ['once with an invalid date', { id: 'licence', label: 'Invented licence', frequency: 'once', date: '2026-02-30', amount: 80, confidence: 'estimated' }],
  ['monthly with no day', { id: 'licence', label: 'Invented licence', frequency: 'monthly', amount: 80, confidence: 'estimated' }],
  ['yearly with only a month', { id: 'licence', label: 'Invented licence', frequency: 'yearly', month: 11, amount: 80, confidence: 'estimated' }],
  ['biweekly with no anchor', { id: 'licence', label: 'Invented licence', frequency: 'biweekly', amount: 80, confidence: 'estimated' }],
  ['authored needsDate flag', { id: 'licence', label: 'Invented licence', frequency: 'once', date: '2026-10-20', needsDate: true, amount: 80, confidence: 'estimated' }],
]) {
  const { p, v, cur, next } = view([bill]);
  ok(F.billNeedsDate(bill) === true, `${label}: billNeedsDate`);
  const u = (v.undatedBills || []).find(r => r.id === 'licence');
  ok(u && u.date === null && u.amount === 80 && u.needsDate === true, `${label}: listed undated with amount 80`);
  ok(![...(cur.bills || []), ...(next.bills || [])].some(r => r.id === 'licence'), `${label}: no guessed date in any period`);
  ok(cur.periodBillLoad === null && cur.afterBills === null && next.periodBillLoad === null && next.afterBills === null,
    `${label}: both periods' load and after bills are unknown`);
  ok(walkState(p) === 'unavailable', `${label}: forward walk is withheld`);
}

console.log('=== unknown date bounded by firstDue ===');
{
  const bill = { id: 'licence', label: 'Invented licence', frequency: 'once', amount: 80, firstDue: '2026-11-10', confidence: 'estimated' };
  const { cur, next } = view([bill]);
  ok(cur.periodBillLoad === 90 && cur.afterBills === 1310 && next.periodBillLoad === 0 && next.afterBills === 1400,
    'windows ending before its earliest possible date stay precise');
}

console.log('=== unknown date and amount ===');
{
  const { v } = view([{ id: 'both', label: 'Invented both', frequency: 'once', confidence: 'estimated' }]);
  const u = (v.undatedBills || []).find(r => r.id === 'both');
  ok(u && u.amount === null && u.planned === null && u.movement === null, 'undated amount-less bill keeps a null amount');
}

console.log('=== dated bills are not undated ===');
for (const bill of [
  { frequency: 'once', date: '2026-10-20' }, { frequency: 'monthly', day: 12 }, { frequency: 'monthly', day: '12' },
  { frequency: 'quarterly', day: 5, anchor: '2026-01-05' }, { frequency: 'yearly', month: 3, day: 1 },
  { frequency: 'biweekly', anchor: '2026-10-09' },
]) ok(F.billNeedsDate(bill) === false, `dated ${bill.frequency} is not undated`);

console.log('=== one authority for the date state ===');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'forecast.js'), 'utf8');
  const start = src.indexOf('function billNeedsDate(bill)');
  const end = src.indexOf('\n  }\n', start);
  const outside = (src.slice(0, start) + src.slice(end)).match(/\b(?:b|bill|item)\.needsDate\b/g) || [];
  ok(start > 0 && outside.length === 0, 'no plan-bill needsDate read outside billNeedsDate', outside.join(', '));
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall A6 checks passed');
