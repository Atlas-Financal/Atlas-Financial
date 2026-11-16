'use strict';
/* #821 audit finding 17, slice 2: an income or obligation whose frequency
 * Forecast cannot expand, or an income whose declared amount is not a real
 * amount, fails closed. It publishes as unknown. A mistyped obligation
 * frequency no longer lets the payment vanish from every figure (the balance
 * read ready, higher by the payment), a mistyped income frequency no longer
 * drops the whole stream to $0 (a confident negative balance), and a boolean
 * or array income amount is no longer coerced to $1 or the array's number.
 * Slice 1 (budget targets and the cash buffer) is test-plan-input-fail-closed.
 *
 * Invented world, as-of Wed 2026-10-14. Biweekly pay 1,400 anchored Fri
 * 2026-10-09 (This Pay Period Oct 9 - Oct 22, Next Oct 23 - Nov 5), a
 * monthly side income of 300 on the 28th, hydro 90 on the 20th, a monthly
 * loan payment (an obligation) of 300 on the 22nd, and one household target
 * of 100 a payday.
 *
 * Hand-worked expectations (from the inputs, not from Atlas):
 *   This Pay Period: income 1,400; bills 90 + loan 300 = 390; after bills
 *                    1,400 - 390 = 1,010; hold 100; Balance After Deductions 910.
 *   Next Pay Period: income 1,400 + 300 = 1,700 (side income lands Oct 28);
 *                    no bills; after bills 1,700; hold 100; Balance After
 *                    Deductions 1,600.
 *   Side income declared as the text "1400" is read as 1,400 (numeric text is
 *   an amount, as for bill amounts, #726): next period income 2,800.
 *   A declared side income of 0 is a real zero: next period income 1,400.
 *
 *   node test/test-plan-input-frequency-fail-closed.js
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
const DEBTS = [{ id: 'loan-debt', name: 'Invented loan', balance: 3000, rate: 0.05 }];
const plan = mut => {
  const p = {
    defaults: { targetBuffer: 500 }, startingCash: { amount: 5000 },
    opening: { asOf: AS_OF, priorAsOf: '2026-10-09', representedEvents: [] },
    income: [
      { id: 'payroll', label: 'Invented pay', frequency: 'biweekly', anchor: '2026-10-09', amount: 1400, confidence: 'confirmed' },
      { id: 'side', label: 'Invented side income', frequency: 'monthly', day: 28, amount: 300, confidence: 'confirmed' },
    ],
    bills: [{ id: 'hydro', label: 'Invented hydro', frequency: 'monthly', day: 20, amount: 90, confidence: 'confirmed' }],
    obligations: [{ id: 'loan', label: 'Invented loan', debtId: 'loan-debt', effect: 'payment', frequency: 'monthly', day: 22, amount: 300, confidence: 'confirmed' }],
    commitments: [],
    budget: { categories: [{ id: 'groceries', label: 'Invented groceries', plannedPayday: 100 }] },
  };
  if (mut) mut(p);
  return p;
};
const read = (p, opts) => {
  const r = F.recommend(p, AS_OF, Object.assign({ debts: DEBTS }, opts || {}));
  const v = r.defaultView;
  const by = id => v.calendarPeriods.find(x => x.id === id);
  return { r, v, cur: by('this-pay-period'), next: by('next-pay-period'),
    status: r.scheduledAmounts ? r.scheduledAmounts.status : 'ready',
    unknowns: r.scheduledAmounts ? r.scheduledAmounts.unknowns : [] };
};

console.log('\n=== 1. controls: a well-formed plan is known and unchanged ===');
{
  const g = read(plan());
  ok(g.status === 'ready' && g.unknowns.length === 0, 'no scheduled-amount unknown');
  ok(g.cur.incomeTotal === 1400 && g.cur.afterBills === 1010 && g.cur.balanceAfterDeductions === 910,
    'This Pay Period: income 1,400, after bills 1,010, Balance After Deductions 910');
  ok(g.next.incomeTotal === 1700 && g.next.afterBills === 1700 && g.next.balanceAfterDeductions === 1600,
    'Next Pay Period: income 1,700, after bills 1,700, Balance After Deductions 1,600');
  ok(g.r.sim.totals.obligations === 900, 'the walk carries the loan payments (3 x 300 in the 91-day window)');
  const text = read(plan(p => { p.income[1].amount = '1400'; }));
  ok(text.status === 'ready' && text.next.incomeTotal === 2800,
    'a numeric-text income amount "1400" is read as 1,400 (unchanged, as for bill amounts)');
  const zero = read(plan(p => { p.income[1].amount = 0; }));
  ok(zero.status === 'ready' && zero.next.incomeTotal === 1400, 'a declared income of 0 is a real zero');
  const once = read(plan(p => { p.income.push({ id: 'later', label: 'Invented later', frequency: 'once', date: '2028-06-01', amount: true }); }));
  ok(once.status === 'ready', 'a malformed amount on a stream that never occurs inside the forecast horizon does not block it');
  const off = read(plan(p => { p.income[1].frequency = 'Monthly'; }), { disabled: ['side'] });
  ok(off.status === 'ready', 'a disabled income stream is not judged');
  const none = read(plan(p => { delete p.income[1].amount; p.income[1].scenarioMonthly = { expected: 300 }; }));
  ok(none.status === 'ready', 'a stream that declares no amount (scenarioMonthly carries it) is unchanged');
}

console.log('\n=== 2. an obligation\'s frequency: a mistyped value never makes the payment vanish ===');
for (const [label, value] of [['"Monthly"', 'Monthly'], ['"MONTHLY"', 'MONTHLY'], ['"monthly " (trailing space)', 'monthly '],
  ['"monthy"', 'monthy'], ['"weekly" (not a supported cadence)', 'weekly'], ['blank ""', ''], ['null', null],
  ['a number', 5], ['true', true]]) {
  const g = read(plan(p => { p.obligations[0].frequency = value; }));
  ok(g.status === 'unavailable' && g.unknowns.some(u => u.carrier === 'obligation' && u.id === 'loan'),
    `${label}: scheduled amounts unavailable, the loan is named (not dropped)`);
  ok(g.cur.afterBills === null && g.cur.balanceAfterDeductions === null
    && g.next.afterBills === null && g.next.balanceAfterDeductions === null,
    `${label}: after bills and Balance After Deductions are unknown in both periods (not 1,310 / 1,210)`);
  ok(g.r.sim.totals.obligations === null, `${label}: the walk's obligation total is unknown, not 0`);
}

console.log('\n=== 3. an income stream\'s frequency: a mistyped value never drops the stream to $0 ===');
for (const [label, value] of [['"Biweekly"', 'Biweekly'], ['"weekly" (not a supported cadence)', 'weekly'],
  ['blank ""', ''], ['null', null], ['a number', 5], ['true', true]]) {
  const g = read(plan(p => { p.income[0].frequency = value; }));
  ok(g.status === 'unavailable' && g.unknowns.some(u => u.carrier === 'income' && u.id === 'payroll'),
    `${label}: scheduled amounts unavailable, payroll is named`);
  ok(g.cur.incomeTotal === null && g.next.incomeTotal === null,
    `${label}: period income is unknown in both periods (not 0 and not the side income alone)`);
  ok(g.cur.afterBills === null && g.cur.balanceAfterDeductions === null
    && g.next.afterBills === null && g.next.balanceAfterDeductions === null,
    `${label}: after bills and Balance After Deductions are unknown (not -390 / -490)`);
}

console.log('\n=== 4. an income amount: a boolean, an array, an object or non-numeric text is unknown ===');
for (const [label, value] of [['true', true], ['false', false], ['array [1000]', [1000]], ['object {}', {}],
  ['text "tbd"', 'tbd'], ['blank ""', ''], ['blank " "', ' '], ['NaN', NaN], ['Infinity', Infinity]]) {
  const g = read(plan(p => { p.income[1].amount = value; }));
  ok(g.status === 'unavailable' && g.unknowns.some(u => u.carrier === 'income' && u.id === 'side'),
    `income amount ${label}: scheduled amounts unavailable, the side income is named`);
  ok(g.next.incomeTotal === null && g.next.afterBills === null && g.next.balanceAfterDeductions === null,
    `income amount ${label}: the period income is unknown, not $1 / the array's number / the payroll alone`);
}

console.log('\n=== 5. the committed plan reads as well-formed: nothing new is flagged ===');
{
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
  const committed = data.plan;
  const asOf = committed.opening && committed.opening.asOf;
  const state = F.scheduledAmountState(committed, asOf, '2027-12-31', { targetBuffer: committed.defaults.targetBuffer });
  ok(!state.unknowns.some(u => u.reason === 'plan-frequency-invalid' || u.reason === 'plan-amount-invalid'),
    'no income or obligation of the committed plan is flagged by the slice 2 check');
  const FREQS = new Set(['once', 'biweekly', 'monthly', 'quarterly', 'yearly']);
  ok((committed.income || []).every(s => FREQS.has(s.frequency)) && (committed.obligations || []).every(o => FREQS.has(o.frequency)),
    'every committed income and obligation names a supported frequency');
  ok((committed.income || []).every(s => s.amount == null || (typeof s.amount === 'number' && Number.isFinite(s.amount))),
    'every declared committed income amount is a finite number');
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nAll plan-input frequency fail-closed checks passed.');
