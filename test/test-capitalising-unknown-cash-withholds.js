'use strict';
/*
 * Gemini hunt 4 finding 1: a capitalising (nonCash) obligation whose
 * amountSchedule term cashPayment is unknown for the period. Its cash
 * minimum leaves joint cash, so the pay-period bill load, the remaining
 * Bills figure and Balance After Deductions must read unknown (null,
 * unavailable), never the known-zero figures. Invented fixture only.
 * Independent proof: the expected values are the known-zero control run
 * and a hand-stated 40 cash leg, not a re-derivation through the helper.
 */
const F = require('../public/forecast.js');
const fx = require('./fixtures/other-period-target');
let failures = 0;
const ok = (c, m, d) => { console.log((c ? 'ok   ' : 'FAIL ') + m + (c || d === undefined ? '' : ' :: ' + d)); if (!c) failures++; };
const run = (cash, extra) => {
  const f = fx.build(900);
  f.plan.obligations = (f.plan.obligations || []).concat([Object.assign({ id: 'inv-line', debtId: 'inv-line',
    effect: 'capitalise', label: 'Invented line', frequency: 'monthly', day: 28, amount: 5, confidence: 'confirmed',
    nonCash: true, payingAccount: f.plan.startingCash.breakdown[0].id, cashPayment: 0, cashDay: 6,
    cashLabel: 'Invented minimum', cashConfidence: 'confirmed',
    amountSchedule: [{ from: '2000-01-01', until: '2100-01-01', amount: 5, cashPayment: cash }] }, extra || {})]);
  const a = F.recommend(f.plan, f.date, { ...f.plan.defaults, debts: [], currentPeriodActuals: f.packet });
  return role => a.payPeriodViews.find(v => v.timelineRole === role);
};
const zero = run(0), forty = run(40), unknown = run(null);
const cur = unknown('current');
ok(zero('current').periodBillLoad === 0 && forty('current').periodBillLoad === 40, 'control: a known cash leg loads 0 / 40');
ok(forty('current').remainingBills === 40, 'control: a known 40 leg is a remaining bill');
ok(cur.periodBillLoad === null, 'unknown cash leg: period bill load is unknown, never 0', cur.periodBillLoad);
ok(cur.remainingBills === null, 'unknown cash leg: remaining bills is unknown, never 0', cur.remainingBills);
ok(cur.balanceAfterDeductions === null && cur.balanceAfterDeductionsTrust === 'unavailable',
  'unknown cash leg: Balance After Deductions is withheld', cur.balanceAfterDeductions);
ok(JSON.stringify(cur.billLoadUnknownFrom) === JSON.stringify([{ carrier: 'obligation', id: 'inv-line' }]),
  'the withheld total names the capitalising row', JSON.stringify(cur.billLoadUnknownFrom));
for (const role of ['next', 'future'])
  ok(unknown(role).periodBillLoad === zero(role).periodBillLoad && unknown(role).balanceAfterDeductions === zero(role).balanceAfterDeductions,
    role + ': a period without the unknown leg is unchanged');
const offJoint = run(null, { jointCash: false });
ok(offJoint('current').periodBillLoad === 0, 'a non-joint-cash row stays out of the joint load');
console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
