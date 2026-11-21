'use strict';
/* Owner fact (Dale, 2026-11-20): a bounded recurring payment on the 3rd is the card's payment for its months, so
 * the minimum row on the 8th starts after the last one. Modelled with dated plan.obligations rows only (firstDue /
 * lastDue), no engine concept. Invented figures only; every expected value is worked by hand below. */
const path = require('node:path');
const F = require('../public/forecast');
let failures = 0, checks = 0;
const ok = (cond, label, detail) => { checks++; if (cond) console.log('  PASS  ' + label); else { failures++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); } };
const J = x => JSON.stringify(x);
function ledger() {
  const data = require(path.join(__dirname, 'fixtures/card-backfill-data'))('tdcc', 'invented-min').data;
  data.meta.asOf = '2038-05-01'; data.plan.opening = { asOf: '2038-05-01', representedEvents: [] };
  data.plan.windowDays = 200; data.plan.income[0].amount = 0;
  data.plan.budget.categories = []; data.plan.bills = []; data.plan.commitments = [];
  data.debts[0].balance = 5000; data.debts[0].rate = 21.99;
  data.plan.obligations = [
    { id: 'invented-early', label: 'Invented early payment', debtId: 'tdcc', effect: 'payment', frequency: 'monthly',
      day: 3, firstDue: '2038-06-03', lastDue: '2038-08-03', amount: 444, confidence: 'confirmed', payingAccount: 'chequing-a' },
    // Hand: 1,234.56 × 21.99% / 12 = 22.62 → $23, from September only.
    { id: 'invented-min', label: 'Invented minimum', debtId: 'tdcc', effect: 'payment', frequency: 'monthly',
      day: 8, firstDue: '2038-09-08', amount: 99, confidence: 'estimated', payingAccount: 'chequing-a',
      fixedInterestMinimum: { balance: 1234.56, rate: 21.99, asOf: '2038-04-18' } }];
  return data;
}
const evs = F.expandEvents(ledger().plan, '2038-05-01', '2038-11-30', {})
  .filter(e => e.kind === 'obligation' && /^invented-/.test(e.id)).map(e => [e.date, e.id, Math.abs(e.amount)]);

console.log('1. Three early payments, then the minimum');
ok(J(evs) === J([['2038-06-03', 'invented-early', 444], ['2038-07-03', 'invented-early', 444], ['2038-08-03', 'invented-early', 444],
  ['2038-09-08', 'invented-min', 23], ['2038-10-08', 'invented-min', 23], ['2038-11-08', 'invented-min', 23]]),
  'Jun, Jul, Aug 3 pay 444; no minimum on Jun–Aug 8; $23 minimum from Sep 8', J(evs));
const perMonth = {};
for (const [d] of evs) perMonth[d.slice(0, 7)] = (perMonth[d.slice(0, 7)] || 0) + 1;
ok(Object.values(perMonth).every(n => n === 1) && Object.keys(perMonth).length === 6, 'exactly one card payment in each month', J(perMonth));
ok(evs.filter(e => e[1] === 'invented-early').reduce((s, e) => s + e[2], 0) === 1332, 'early payments total 3 × 444 = 1,332, counted once', J(evs));

console.log('2. The day before payday is in the period that ends that day');
{
  const fx = require('./fixtures/bills-period-end-balance-data');
  const run = date => { const x = fx.requirementsFixture();
    if (date) x.plan.obligations.push({ id: 'invented-early', label: 'Invented', effect: 'payment', frequency: 'monthly',
      day: +date.slice(8), firstDue: date, lastDue: date, amount: 300, confidence: 'confirmed', payingAccount: 'chequing-a' });
    return F.billsAccountPeriodBalance(x.plan, x.asOf, x.opts); };
  const base = run(null), last = run('2026-08-27'), payday = run('2026-08-28');
  ok(base.end === '2026-08-27' && F.spendingCycle(fx.requirementsFixture().plan, '2026-08-20').nextPayday === '2026-08-28',
    'fixture period Aug 14–27, payday Aug 28', J([base.end]));
  ok(Math.round((base.amount - last.amount) * 100) === 30000 && last.status === 'ready',
    'a 300 payment on Aug 27 (the day before payday) lowers this period\'s Bills end balance by exactly 300', J([base.amount, last.amount]));
  ok(payday.amount === base.amount, 'the same payment on payday Aug 28 belongs to the next period (no change here)', J([base.amount, payday.amount]));
}
console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
