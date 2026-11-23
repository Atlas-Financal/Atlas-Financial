'use strict';
/*
 * An unknown obligation amount withholds the pay-period bill load exactly
 * when its known amount would load. Obligation events always leave joint
 * cash (jointCash / heldElsewhere is a bill contract), so a jointCash:false
 * row's KNOWN amount loads; its UNKNOWN amount must withhold, never drop out
 * and leave the period ready. (Review 7102625382 on #1601.) Invented only;
 * expected values are the known-amount control runs.
 */
const F = require('../public/forecast.js');
const fx = require('./fixtures/other-period-target');
let failures = 0;
const ok = (c, m, d) => { console.log((c ? 'ok   ' : 'FAIL ') + m + (c || d === undefined ? '' : ' :: ' + JSON.stringify(d))); if (!c) failures++; };
const view = row => {
  const f = fx.build(900);
  f.plan.obligations = (f.plan.obligations || []).concat([Object.assign({ payingAccount: f.plan.startingCash.breakdown[0].id }, row)]);
  const a = F.recommend(f.plan, f.date, { ...f.plan.defaults, debts: [], currentPeriodActuals: f.packet });
  return a.payPeriodViews.find(v => v.timelineRole === 'current');
};
const loan = extra => Object.assign({ id: 'inv-loan', debtId: 'inv-loan', effect: 'payment', label: 'Invented loan',
  frequency: 'monthly', day: 6, amount: 40, confidence: 'confirmed' }, extra || {});
const line = extra => Object.assign({ id: 'inv-line', debtId: 'inv-line', effect: 'capitalise', label: 'Invented line',
  frequency: 'monthly', day: 28, amount: 5, confidence: 'confirmed', nonCash: true, cashPayment: 40, cashDay: 6,
  cashLabel: 'Invented minimum', cashConfidence: 'confirmed' }, extra || {});
const unknownLine = extra => line(Object.assign({ cashPayment: 0,
  amountSchedule: [{ from: '2000-01-01', until: '2100-01-01', amount: 5, cashPayment: null }] }, extra || {}));
const unknownLoan = extra => loan(Object.assign({ amountSchedule: [{ from: '2000-01-01', until: '2100-01-01', amount: null }] }, extra || {}));
const withheld = v => v.periodBillLoad === null && v.remainingBills === null && v.balanceAfterDeductions === null;

for (const [name, known, unknown] of [['payment row', loan, unknownLoan], ['capitalising cash leg', line, unknownLine]]) {
  const base = view(known()).periodBillLoad, nonJoint = view(known({ jointCash: false })).periodBillLoad;
  ok(base === 40 && nonJoint === 40, `${name}: a known amount loads 40 with or without jointCash:false (unchanged)`, { base, nonJoint });
  ok(withheld(view(unknown())), `${name}: an unknown amount withholds`);
  const v = view(unknown({ jointCash: false }));
  ok(withheld(v), `${name}: jointCash:false unknown withholds, never a ready period without it`,
    { load: v.periodBillLoad, bad: v.balanceAfterDeductions });
  ok(JSON.stringify(v.billLoadUnknownFrom) === JSON.stringify([{ carrier: 'obligation', id: known().id }]), `${name}: the withheld total names the row`, v.billLoadUnknownFrom);
}
console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
