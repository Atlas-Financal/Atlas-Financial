'use strict';
/* Paid-with-excess bill state (acceptance scenario 6.5; adopted bills
 * blueprint #787 6595179923: "Paid / partial / excess state — new
 * Forecast.billPaymentState"; integer cents, zero tolerance).
 *
 * A bill settled by a payment larger than its planned amount stays Paid
 * with remaining 0, and the paid cents above plan are published once as
 * `excess` (calculated) on the bill row, printed on the Budget bill row and
 * in the bill detail. Exact and missing payments publish no excess. The
 * settled status, the remaining amount and the period totals do not change.
 *
 * Paths:
 *   1. Forecast.billPaymentState on hand-written cents;
 *   2. invented raw Lunch Money payload -> scripts/live-plan.js
 *      fromObservation -> Forecast.recommend defaultView.calendarPeriods,
 *      the rows the Budget page prints;
 *   3. the Budget printers (plan.js budgetBillPresentation, bill-detail.js).
 * Every expected value is written by hand. Invented numbers only.
 *
 * `node test/test-bill-payment-excess.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const H = require('./acceptance/harness.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

console.log('Forecast.billPaymentState (integer cents)');
for (const [planned, paid, want, label] of [
  [90, 100, { state: 'paid-excess', excessCents: 1000 }, '100 on a 90 bill: excess 10.00'],
  [90, 90, { state: 'paid-exact', excessCents: 0 }, '90 on a 90 bill: no excess'],
  [90.1, 90.11, { state: 'paid-excess', excessCents: 1 }, 'one cent over is an excess (zero tolerance)'],
  [100, 40, { state: 'underpaid', excessCents: 0 }, '40 on a 100 bill: no excess, not exact'],
  [-90, -100, { state: 'paid-excess', excessCents: 1000 }, 'signed inputs are read as magnitudes'],
  [90, null, { state: 'unknown', excessCents: null }, 'a missing paid amount is unknown, not zero'],
  [null, 100, { state: 'unknown', excessCents: null }, 'a missing planned amount is unknown'],
  [90, 100.005, { state: 'unknown', excessCents: null }, 'a non-cent amount is unknown'],
]) {
  const got = F.billPaymentState(planned, paid);
  ok(got.state === want.state && got.excessCents === want.excessCents, label, JSON.stringify(got));
}

function rowsFor(bill, txs) {
  const w = H.baseWorld();
  w.bills = [bill];
  w.transactions = txs;
  const r = H.observe(w);
  if (r.error) throw r.error;
  const rec = F.recommend(r.plan, w.asOf, { currentPeriodActuals: r.packet });
  const periods = (rec.defaultView && rec.defaultView.calendarPeriods) || [];
  const current = periods.find(p => p.start <= w.asOf && p.end >= w.asOf) || periods[0];
  return { period: current, row: (current.bills || []).find(b => b.id === bill.id) };
}
const HYDRO = { id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12,
  confidence: 'confirmed', payee: 'Invented hydro' };
const pay = amount => H.lm({ date: '2026-10-12', amount, category: 'Utilities', account: 'chequing-a',
  payee: 'Invented hydro' });

console.log('Published bill rows');
{
  const { period, row } = rowsFor({ ...HYDRO, rule: { settlesWhen: 'amount-at-least' } }, [pay(100)]);
  ok(row && row.status === 'PAID', '100 on a 90 bill is PAID', row && row.status);
  ok(row && row.remaining === 0, 'remaining is 0', row && row.remaining);
  ok(row && row.actual === 100 && row.planned === 90, 'actual 100 and planned 90 unchanged', row && `${row.actual}/${row.planned}`);
  ok(row && row.excess === 10 && row.excessTrust === 'calculated', 'excess 10.00 is published as calculated',
    row && `${row.excess} ${row.excessTrust}`);
  ok(period && period.paidBills === 100, 'paid bills total still counts the 100 that left (unchanged)', period && period.paidBills);
}
{
  // An estimated planned amount makes the excess estimated, never calculated.
  const { row } = rowsFor({ ...HYDRO, confidence: 'estimated', rule: { settlesWhen: 'amount-at-least' } }, [pay(100)]);
  ok(row && row.excess === 10 && row.excessTrust === 'estimated', 'an estimated bill\'s excess is tagged estimated',
    row && `${row.excess} ${row.excessTrust}`);
}
{
  const { row } = rowsFor({ ...HYDRO }, [pay(90)]);
  ok(row && row.status === 'PAID' && !('excess' in row), 'an exact payment publishes no excess', JSON.stringify(row && row.excess));
}
{
  const { row } = rowsFor({ ...HYDRO }, []);
  ok(row && row.status !== 'PAID' && !('excess' in row), 'an unpaid bill publishes no excess', row && row.status);
}

console.log('Budget printers');
{
  const ctx = { console, Intl, Number, Math, String, Object, Array, JSON };
  vm.createContext(ctx);
  const src = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  vm.runInContext('const money2 = (formatter => n => (n < 0 ? "−$" : "$") + formatter.format(Math.abs(Number(n))))(new Intl.NumberFormat("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));', ctx);
  const plan = src('plan.js');
  const start = plan.indexOf('function budgetBillPresentation(row)');
  const end = plan.indexOf('\nfunction ', start + 10);
  ok(start >= 0 && end > start, 'positive control: budgetBillPresentation found in plan.js');
  vm.runInContext('function isValidIsoCalendarDate(d) { return /^\\d{4}-\\d{2}-\\d{2}$/.test(String(d)); }\n'
    + plan.slice(start, end) + '\nthis.present = budgetBillPresentation;', ctx);
  const excess = ctx.present({ status: 'PAID', settlement: 'represented', excess: 10 });
  ok(excess.label === 'Paid' && excess.qualifier === '$10.00 over planned', 'the Bills row reads "Paid · $10.00 over planned"',
    JSON.stringify(excess));
  const exact = ctx.present({ status: 'PAID', settlement: 'represented' });
  ok(exact.label === 'Paid' && !exact.qualifier, 'an exact payment prints Paid with no qualifier', JSON.stringify(exact));

  const detailCtx = { console, Intl, Number, Math, String, Object, Array, JSON };
  detailCtx.window = detailCtx; detailCtx.self = detailCtx;
  vm.createContext(detailCtx);
  vm.runInContext(src('bill-detail.js'), detailCtx);
  const BD = detailCtx.BillDetail;
  ok(BD && typeof BD.html === 'function', 'positive control: BillDetail.html loaded');
  const html = BD.html({ id: 'hydro', label: 'Invented hydro', status: 'PAID', settlement: 'represented',
    date: '2026-10-12', planned: 90, actual: 100, remaining: 0, excess: 10 }, {}, {});
  ok(/Paid over planned<\/dt><dd>\$10\.00 excess · calculated/.test(html), 'the bill detail discloses the 10.00 excess as calculated');
  const est = BD.html({ id: 'hydro', label: 'Invented hydro', status: 'PAID', settlement: 'represented',
    date: '2026-10-12', planned: 90, actual: 100, remaining: 0, excess: 10, excessTrust: 'estimated' }, {}, {});
  ok(/Paid over planned<\/dt><dd>\$10\.00 excess · estimated/.test(est), 'an estimated excess prints as estimated');
  const plain = BD.html({ id: 'hydro', label: 'Invented hydro', status: 'PAID', settlement: 'represented',
    date: '2026-10-12', planned: 90, actual: 90, remaining: 0 }, {}, {});
  ok(!/over planned/.test(plain) && /Planned<\/dt>/.test(plain), 'no excess line without a published excess');
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll bill payment excess checks passed.');
