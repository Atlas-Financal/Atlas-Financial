'use strict';
/* The opening gap's "money needed by" date is the first day the balance is
 * actually overdrawn, by the same half-cent below(x, 0) every overdraft flag
 * uses (#914). Float noise under zero is not an overdraft.
 *
 * Invented case, as-of 2026-10-01, buffer $100, no payday until Oct 14:
 *
 *   opening cash            0.30
 *   Oct 2   bills 0.10 + 0.20  -> balance 0.00   (in floats: about -2.8e-17)
 *   Oct 10  bill 300.00        -> balance -300.00
 *
 * Hand-derived: the account first goes overdrawn on Oct 10, not Oct 2.
 *   gap date      2026-10-10
 *   gap amount    100 - (-300) = 400.00
 *   due that day  300.00 (the Oct 10 bill)
 * Before the fix, the bare `< 0` read the Oct 2 float noise as overdrawn and
 * named Oct 2, with only the 0.30 of Oct 2 bills due that day.
 *
 * Control: a real one-cent overdraft on Oct 2 (bills 0.11 + 0.20) is still
 * overdrawn, so the date stays Oct 2. Expected values are hand-derived here,
 * independent of the engine.
 */
const assert = require('node:assert/strict');
const F = require('../public/forecast');

function plan(secondBill) {
  const bill = (id, date, amount) => ({ id, label: 'Invented ' + id, frequency: 'once', date, amount,
    confidence: 'confirmed', payingAccount: 'chequing-a' });
  return {
    windowDays: 28,
    defaults: { targetBuffer: 100 },
    startingCash: { asOf: '2026-10-01', breakdown: [{ id: 'chequing-a', label: 'BILLS', value: 0.3 }] },
    opening: { asOf: '2026-10-01', representedEvents: [] },
    income: [{ id: 'payroll', label: 'Invented salary', frequency: 'biweekly', anchor: '2026-10-14',
      amount: 2000, confidence: 'confirmed' }],
    bills: [bill('a', '2026-10-02', secondBill), bill('b', '2026-10-02', 0.2), bill('c', '2026-10-10', 300)],
    obligations: [], commitments: [], budget: { categories: [] },
  };
}
const gapOf = p => F.recommend(p, '2026-10-01', { targetBuffer: 100, debts: [] }).gap;
const cents = n => Math.round(n * 100);
let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };

{
  const gap = gapOf(plan(0.1));
  check(gap, 'a gap is published (the account goes below the buffer)');
  check(gap.date === '2026-10-10', `float noise on Oct 2 is not an overdraft: gap date is Oct 10 (got ${gap.date})`);
  check(cents(gap.amount) === 40000, `gap amount is 400.00 (got ${gap.amount})`);
  check(cents(gap.dueOnGapDay) === 30000, `due on the gap day is the 300.00 bill (got ${gap.dueOnGapDay})`);
}
{
  const gap = gapOf(plan(0.11));
  check(gap && gap.date === '2026-10-02', `a real one-cent overdraft on Oct 2 keeps Oct 2 (got ${gap && gap.date})`);
  check(cents(gap.dueOnGapDay) === 31, `due on Oct 2 is the 0.31 of bills (got ${gap.dueOnGapDay})`);
}
console.log(`  PASS  the opening gap date ignores sub-cent float noise under zero (${checks} checks)`);
