'use strict';
/* A completed pay period never prints "Remaining bills to pay $0.00" beside
 * an unpaid bill. It is settlement evidence, not an amount due, so its
 * actionable remainder stays 0 (an unproven bill's "still to pay" home is
 * the current period, not a second copy here), and it publishes
 * `unconfirmedBills`: the bills its evidence does not prove paid, printed
 * "Not confirmed paid". Invented case, hand-computed here:
 *
 *   internet  60, paid Sep 28 (posted debit)      -> paid
 *   water    120, due Oct 1, no matching debit    -> unpaid, remaining 120
 *   total 180 = paid 60 + not confirmed paid 120
 *
 * Before the fix the period printed "Remaining bills to pay $0.00" beside a
 * water row that said Remaining $120.00, and paid + remaining != total.
 *
 * Runs the production observation path (scripts/live-plan via the
 * acceptance harness's dataOf) and Forecast.recommend, then the incumbent
 * plan.js printer for the period's bills block.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const H = require('./acceptance/harness');
const F = require('../public/forecast');

const PAID = 60, UNPAID = 120, TOTAL = PAID + UNPAID;
function world(extraBills = []) {
  const w = H.baseWorld();
  w.bills = [
    { id: 'net', label: 'Invented internet', amount: PAID, frequency: 'monthly', day: 28, confidence: 'confirmed', payee: 'Invented net co' },
    { id: 'water', label: 'Invented water', amount: UNPAID, frequency: 'monthly', day: 1, confidence: 'confirmed', payee: 'Invented water co' },
    ...extraBills,
  ];
  w.transactions = [
    H.lm({ id: 900001, date: '2026-09-25', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    H.lm({ id: 900002, date: '2026-09-28', amount: PAID, category: 'Internet', account: 'chequing-a', payee: 'Invented net co' }),
    H.lm({ id: 900004, date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
  ];
  return w;
}
function closedPeriod(w) {
  const { data, packet, error } = H.dataOf(w);
  assert.equal(error, null, 'invented observation is accepted');
  const advice = F.recommend(data.plan, w.asOf, { debts: data.debts, currentPeriodActuals: packet });
  const p = advice.payPeriodViews.find(v => v.start === '2026-09-25');
  assert.ok(p && p.lookback === true, 'Sep 25 - Oct 8 is the completed period');
  return p;
}
// The incumbent bills printer, lifted from plan.js with its formatter.
const planSrc = fs.readFileSync(path.join(__dirname, '../public/plan.js'), 'utf8');
const grab = re => { const m = planSrc.match(re); assert.ok(m, String(re)); return m[0]; };
const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const printer = vm.runInNewContext(`${appSrc.match(/^const money2 = .*$/m)[0]}
${grab(/^function calendarPeriodBillsHtml\([\s\S]*?\n\}$/m)}
({ calendarPeriodBillsHtml })`, { Forecast: F, Intl, periodBillLine: () => '' });
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

{
  const p = closedPeriod(world());
  const water = p.bills.find(b => b.id === 'water');
  eq(water.status, 'planned', 'no evidence proves the water bill paid');
  eq(water.remaining, UNPAID);
  eq(p.totalBillsThisPeriod, TOTAL);
  eq(p.paidBills, PAID);
  eq(p.unconfirmedBills, UNPAID, 'the unpaid bill is not confirmed paid');
  eq(p.remainingBills, 0, 'a completed period is not a second amount due');
  eq(Math.round((p.paidBills + p.unconfirmedBills) * 100), Math.round(p.totalBillsThisPeriod * 100), 'paid + not confirmed = total');
  const printed = text(printer.calendarPeriodBillsHtml(p));
  assert.match(printed, /Not confirmed paid \$120\.00/); checks++;
  assert.doesNotMatch(printed, /Remaining bills to pay/, 'no $0 remaining beside an unpaid row'); checks++;
}

// Every bill paid: nothing remains.
{
  const w = world();
  w.transactions.splice(2, 0, H.lm({ id: 900003, date: '2026-10-01', amount: UNPAID, category: 'Water',
    account: 'chequing-a', payee: 'Invented water co' }));
  const p = closedPeriod(w);
  eq(p.bills.find(b => b.id === 'water').status, 'PAID');
  eq(p.unconfirmedBills, 0);
  eq(p.paidBills, TOTAL);
}

// Production path (Atlas #931 blocker 1): a dated bill in the completed
// window whose amount is unknown is never emitted as a row. It still makes
// the figure unknown, alone or beside a known unpaid bill; never 0 or 120.
for (const extra of [[], [{ id: 'water2', label: 'Invented second water', amount: UNPAID, frequency: 'monthly',
  day: 3, confidence: 'confirmed', payee: 'Invented water two' }]]) {
  const w = world([{ id: 'mystery', label: 'Invented unknown bill', amount: null, frequency: 'monthly', day: 2,
    confidence: 'confirmed', payee: 'Invented mystery co' }, ...extra]);
  w.bills = w.bills.filter(b => b.id !== 'water');
  const p = closedPeriod(w);
  eq(p.bills.some(b => b.id === 'mystery'), false, 'the unknown-amount bill emits no row (upstream)');
  eq(p.unconfirmedBills, null, 'an unknown in-window amount makes the figure unknown, never a smaller known sum');
  eq(p.unconfirmedBillsTrust, 'unavailable');
  eq(p.remainingBills, 0, 'the actionable remainder boundary is unchanged');
  eq(p.totalBillsThisPeriod, null, 'the completed total never sums an unknown amount as 0');
  assert.match(text(printer.calendarPeriodBillsHtml(p)), /Total bills this period Unknown/); checks++;
  assert.match(text(printer.calendarPeriodBillsHtml(p)), /Not confirmed paid Unknown/); checks++;
}

// Atlas #931 blocker 2: an estimated amount keeps its estimate qualification,
// alone or mixed with a confirmed amount (estimated 120 + confirmed 40 = 160).
for (const mixed of [false, true]) {
  const w = world(mixed ? [{ id: 'gas', label: 'Invented gas', amount: 40, frequency: 'monthly', day: 2,
    confidence: 'confirmed', payee: 'Invented gas co' }] : []);
  w.bills.find(b => b.id === 'water').confidence = 'estimated';
  const p = closedPeriod(w);
  eq(p.unconfirmedBills, UNPAID + (mixed ? 40 : 0));
  eq(p.unconfirmedBillsTrust, 'estimated', 'an estimated contributing amount stays estimated');
  assert.match(text(printer.calendarPeriodBillsHtml(p)), new RegExp('Not confirmed paid ≈ estimated \\$' + (mixed ? '160' : '120') + '\\.00')); checks++;
}
// All-confirmed control: calculated, no estimate marker.
{
  const p = closedPeriod(world());
  eq(p.unconfirmedBillsTrust, 'calculated');
  assert.doesNotMatch(text(printer.calendarPeriodBillsHtml(p)), /estimated/); checks++;
}

// An unknown amount makes the remainder unknown, never a smaller known sum.
// The sealed rows the remainder reads are fed directly: on current main an
// amount-unknown bill does not yet reach a completed period's rows (#862).
{
  const fnSrc = s => { const m = fs.readFileSync(path.join(__dirname, '../public/forecast.js'), 'utf8')
    .match(new RegExp('^  function ' + s + '\\([\\s\\S]*?\\n  \\}$', 'm')); assert.ok(m, s); return m[0]; };
  const lib = vm.runInNewContext(`const roundCent = n => Math.round(n * 100) / 100;
${fnSrc('historicalUnconfirmedBills')}
({ historicalUnconfirmedBills })`, {});
  eq(lib.historicalUnconfirmedBills([{ status: 'PAID', remaining: 0 }, { status: 'planned', remaining: UNPAID }]), UNPAID);
  eq(lib.historicalUnconfirmedBills([{ status: 'planned', remaining: UNPAID }, { status: 'planned', remaining: null, amount: null }]), null);
  eq(lib.historicalUnconfirmedBills([{ status: 'planned', remaining: UNPAID }, { status: 'unknown', remaining: 5 }]), null);
  eq(lib.historicalUnconfirmedBills([{ status: 'planned', remaining: UNPAID }, { needsDate: true, status: 'planned', remaining: 9 }]), UNPAID,
    'an undated row keeps its own date-unknown handling');
  const printed = text(printer.calendarPeriodBillsHtml({ lookback: true, bills: [{ id: 'x' }],
    totalBillsThisPeriod: null, paidBills: PAID, remainingBills: 0, unconfirmedBills: null }));
  assert.match(printed, /Not confirmed paid Unknown/); checks++;
}
console.log(`  PASS  completed periods publish bills not confirmed paid, never a $0 remainder (${checks} checks)`);
