'use strict';
/* Owner rule (Dale, 2026-11-20): Triangle's and Amazon's planned minimum is one month's interest on a frozen
 * statement balance at the purchase rate, rounded up to the whole dollar, the same every month, never below the
 * issuer's statement minimum. Invented figures only; every expected value is worked by hand below. */
const path = require('node:path');
const F = require('../public/forecast');
let failures = 0, checks = 0;
const ok = (cond, label, detail) => { checks++; if (cond) console.log('  PASS  ' + label); else { failures++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); } };
const clone = x => JSON.parse(JSON.stringify(x));
function ledger() {
  const data = require(path.join(__dirname, 'fixtures/card-backfill-data'))('tdcc', 'invented-cycle').data;
  data.meta.asOf = '2038-05-01'; data.plan.opening = { asOf: '2038-05-01', representedEvents: [] };
  data.plan.windowDays = 120; data.plan.income[0].amount = 0;
  data.plan.budget.categories = []; data.plan.bills = []; data.plan.commitments = [];
  data.debts[0].balance = 1500; data.debts[0].rate = 21.99;
  // Hand: 1,234.56 × 21.99% / 12 = 22.6233… → up to $23.
  data.plan.obligations = [{ id: 'invented-cycle', label: 'Invented minimum', debtId: 'tdcc', effect: 'payment', frequency: 'monthly',
    day: 8, firstDue: '2038-05-08', amount: 99, confidence: 'estimated', payingAccount: 'chequing-a',
    fixedInterestMinimum: { balance: 1234.56, rate: 21.99, asOf: '2038-04-18' } }];
  return data;
}
const amounts = data => F.expandEvents(data.plan, '2038-05-01', '2038-08-31', {})
  .filter(e => e.kind === 'obligation' && e.id === 'invented-cycle').map(e => [e.date, e.amount, e.confidence]);

console.log('1. The fixed amount, every month');
const base = amounts(ledger());
ok(JSON.stringify(base.map(e => [e[0], Math.abs(e[1])])) === JSON.stringify([['2038-05-08', 23], ['2038-06-08', 23], ['2038-07-08', 23], ['2038-08-08', 23]]),
  '1,234.56 × 21.99% / 12 = 22.62 → $23 on May, Jun, Jul and Aug 8 (not the row estimate 99)', JSON.stringify(base));
ok(base.every(e => e[2] === 'estimated'), 'the row\'s own trust word stays (never promoted)', JSON.stringify(base));

console.log('2. Never below the issuer\'s statement minimum');
{
  const d = ledger();
  d.plan.obligations[0].statementOccurrences = [
    { scheduledDate: '2038-06-08', dueDate: '2038-06-08', minimum: 30.5, currency: 'cad', confidence: 'confirmed' },
    { scheduledDate: '2038-07-08', dueDate: '2038-07-08', minimum: 12, currency: 'cad', confidence: 'confirmed' }];
  const got = amounts(d).map(e => [e[0], Math.abs(e[1]), e[2]]);
  ok(JSON.stringify(got) === JSON.stringify([['2038-05-08', 23, 'estimated'], ['2038-06-08', 30.5, 'confirmed'], ['2038-07-08', 23, 'estimated'], ['2038-08-08', 23, 'estimated']]),
    'statement 30.50 > 23 pays 30.50 (confirmed); statement 12 < 23 pays 23 (the plan\'s trust, not the statement\'s)', JSON.stringify(got));
}

console.log('3. Held: a refreshed balance or rate on the debt does not move it');
{
  const d = ledger(); d.debts[0].balance = 400; d.debts[0].rate = 29.99;
  ok(JSON.stringify(amounts(d)) === JSON.stringify(base), 'debt balance 1,500 → 400 and rate → 29.99: still $23 each month');
  const r = ledger(); r.plan.obligations[0].fixedInterestMinimum.rate = 29.99;
  // Hand: 1,234.56 × 29.99% / 12 = 30.8537… → $31.
  ok(amounts(r).every(e => Math.abs(e[1]) === 31), 'a re-authored snapshot rate 29.99 recomputes: 30.85 → $31', JSON.stringify(amounts(r)));
}

console.log('4. Edges');
{
  // Hand: 1,200.00 × 12% / 12 = 12.00 exactly → $12 (no round-up of a whole dollar).
  const e = ledger(); e.plan.obligations[0].fixedInterestMinimum = { balance: 1200, rate: 12, asOf: '2038-04-18' };
  ok(amounts(e).every(x => Math.abs(x[1]) === 12), 'an exact whole dollar stays: 1,200 × 12% / 12 = $12', JSON.stringify(amounts(e)));
  for (const [label, bad] of [['no rate', { balance: 1200, asOf: '2038-04-18' }], ['zero balance', { balance: 0, rate: 12, asOf: '2038-04-18' }],
    ['bad date', { balance: 1200, rate: 12, asOf: '2038-13-01' }], ['fractional cents', { balance: 1200.001, rate: 12, asOf: '2038-04-18' }]]) {
    const b = ledger(); b.plan.obligations[0].fixedInterestMinimum = bad;
    let threw = false; try { amounts(b); } catch { threw = true; }
    ok(threw, 'a malformed snapshot fails closed: ' + label);
  }
  const plain = ledger(); delete plain.plan.obligations[0].fixedInterestMinimum;
  ok(amounts(plain).every(x => Math.abs(x[1]) === 99), 'without the rule the row estimate stands (other cards unchanged)');
}

console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nAll ${checks} fixed interest minimum checks passed`);
process.exit(failures ? 1 : 0);
