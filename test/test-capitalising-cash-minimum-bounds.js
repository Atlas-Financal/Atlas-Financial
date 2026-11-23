'use strict';
/*
 * Gemini hunt 4 finding 6: the capitalising cash-minimum leg is built from
 * the row's cadence and bounds. An ended row (lastDue) stops its cash minimum
 * at its last cash date on or before lastDue, the same filter every other
 * recurring schedule applies (`occurrences`): no occurrence after lastDue.
 * Expected dates are stated by hand, not re-derived. Invented values only.
 */
const F = require('../public/forecast.js');
let failures = 0;
const ok = (c, m, d) => { console.log((c ? 'ok   ' : 'FAIL ') + m + (c || d === undefined ? '' : ' :: ' + JSON.stringify(d))); if (!c) failures++; };
const START = '2027-01-01', END = '2027-08-31';
const line = extra => Object.assign({ id: 'line', debtId: 'line', effect: 'capitalise', label: 'Invented line interest',
  frequency: 'monthly', day: 28, amount: 80, confidence: 'confirmed', nonCash: true, payingAccount: 'chequing-a',
  cashPayment: 60, cashDay: 15, cashLabel: 'Invented line minimum', cashConfidence: 'confirmed' }, extra || {});
const plan = obligations => ({ windowDays: 60, defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
  startingCash: { breakdown: [{ id: 'chequing-a', value: 9000 }, { id: 'chequing-b', value: 0 }] }, opening: { asOf: START },
  budget: { basis: 'ytd', categories: [] }, income: [], bills: [], obligations, commitments: [] });
const cash = p => F.expandEvents(p, START, END, {}).filter(e => e.id === 'line' && e.cashMinimum === true).map(e => e.date);
const all = ['2027-01-15', '2027-02-15', '2027-03-15', '2027-04-15', '2027-05-15', '2027-06-15', '2027-07-15', '2027-08-15'];

ok(JSON.stringify(cash(plan([line()]))) === JSON.stringify(all), 'unended row: a cash minimum every month (unchanged)', cash(plan([line()])));
const ended = cash(plan([line({ lastDue: '2027-04-28' })]));
ok(JSON.stringify(ended) === JSON.stringify(all.slice(0, 4)), 'ended row: cash stops at its last cash date on or before lastDue (Apr 15)', ended);
const onDay = cash(plan([line({ lastDue: '2027-04-15' })]));
ok(JSON.stringify(onDay) === JSON.stringify(all.slice(0, 4)), 'lastDue on a cash date keeps that date (inclusive)', onDay);
const sched = cash(plan([line({ lastDue: '2027-04-28', cashPayment: 0,
  amountSchedule: [{ from: '2026-12-01', until: '2027-12-01', amount: 80, cashPayment: 60 }] })]));
ok(JSON.stringify(sched) === JSON.stringify(all.slice(0, 4)), 'dated amountSchedule leg: the same bound applies', sched);
const unk = F.scheduledAmountState(plan([line({ lastDue: '2027-04-28', cashPayment: 0,
  amountSchedule: [{ from: '2027-06-01', until: '2027-12-01', amount: 80, cashPayment: null }] })]), START, END, {})
  .unknowns.filter(u => u.cashMinimum);
ok(unk.length === 0, 'an unknown cash term after lastDue is no longer named unknown', unk);
// Household-shaped HELOC: cashFirstDue, no lastDue.
const heloc = cash(plan([line({ cashFirstDue: '2027-03-15', cashDay: 15 })]));
ok(JSON.stringify(heloc) === JSON.stringify(all.slice(2)), 'cashFirstDue without lastDue: from Mar 15, unbounded (unchanged)', heloc);
console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
