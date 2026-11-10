'use strict';
const assert = require('node:assert/strict');
const F = require('../public/forecast'), fx = require('./fixtures/bills-period-end-balance-data');
let checks = 0;
const cases = [];
const run = (name, change, expected, code) => {
  const x = fx.requirementsFixture(); if (change) change(x);
  const before = JSON.stringify(x);
  cases.push({ name, input: x, expected });
  const actual = F.billsAccountPeriodBalance(x.plan, x.asOf, x.opts);
  const published = F.recommend(x.plan, x.asOf, x.opts).defaultView.billsAccountPeriodBalance;
  for (const row of [actual, published]) {
    assert.equal(row.amount, expected, name + ': independent cents');
    assert.equal(row.status, expected == null ? 'unavailable' : 'ready', name + ': status');
    assert.equal(row.trust, expected == null ? 'unknown' : 'estimated', name + ': trust');
    assert.equal(row.observedCash, 823.47, name + ': known stock preserved');
    assert.equal(row.grantsSpendPermission, false, name + ': no permission');
    if (code) assert(row.issues.some(issue => issue.code === code), name + ': explicit issue');
    checks += 5 + (code ? 1 : 0);
  }
  assert.equal(JSON.stringify(x), before, name + ': no input mutation');
  assert.deepEqual(F.billsAccountPeriodBalance(x.plan, x.asOf, x.opts), actual, name + ': repeat stable');
  checks += 2;
};
// Independently selected review identity: 823.47 + 263.19 - 17.23 - 9.41
// - (71.13 + 29.27) = 959.62. No production cents are used.
run('native known independent identity', null, 959.62);
for (const [kind, select, code] of [
  ['bill', x => x.plan.bills[0], 'remaining-cash-unknown'],
  ['commitment', x => x.plan.commitments[0], 'remaining-cash-unknown'],
  ['income', x => x.plan.income[1], 'income-unavailable'],
]) {
  for (const [label, value] of [['null', null], ['missing', undefined], ['NaN', NaN], ['infinite', Infinity]]) {
    run('native ' + kind + ' ' + label, x => { const row = select(x); if (value === undefined) delete row.amount; else row.amount = value; }, null, code);
  }
}
run('native authored bill zero is unknown', x => { x.plan.bills[0].amount = 0; }, null, 'remaining-cash-unknown');
run('native authored commitment zero is unknown', x => { x.plan.commitments[0].amount = 0; }, null, 'remaining-cash-unknown');
run('native income known zero', x => { x.plan.income[1].amount = 0; }, 696.43);
for (const payer of ['chequing-b', 'savings']) {
  run('native bill paid by ' + payer, x => { x.plan.bills[0].payingAccount = payer; }, 976.85);
  run('native commitment paid by ' + payer, x => { x.plan.commitments[0].payingAccount = payer; }, 969.03);
  run('native other-account unknown bill ' + payer, x => { x.plan.bills[0].payingAccount = payer; x.plan.bills[0].amount = null; }, 976.85);
}
run('native unknown explicit bill payer', x => { x.plan.bills[0].payingAccount = 'unconfirmed-account'; }, null, 'remaining-cash-account-unconfirmed');
run('native unknown explicit commitment payer', x => { x.plan.commitments[0].payingAccount = 'unconfirmed-account'; }, null, 'remaining-cash-account-unconfirmed');
run('native unassigned payer discloses Bills anchor', x => { delete x.plan.bills[0].payingAccount; }, 959.62);
run('native outside-period unknown bill', x => { x.plan.bills[0].amount = null; x.plan.bills[0].date = '2026-08-28'; }, 976.85);
run('native outside-period unknown commitment', x => { x.plan.commitments[0].amount = null; x.plan.commitments[0].date = '2026-08-28'; }, 969.03);
run('native optional unknown commitment', x => { x.plan.commitments[0].amount = null; x.plan.commitments[0].optional = true; }, 969.03);
run('native disabled unknown commitment', x => { x.plan.commitments[0].amount = null; x.opts.disabled = ['cost']; }, 969.03);
run('native settled unknown commitment', x => { x.plan.commitments[0].amount = null; x.plan.commitments[0].settledOn = fx.AS_OF; }, 969.03);
run('native named no-pay unknown bill', x => { x.plan.bills[0].amount = null; x.plan.bills[0].noPaymentRequiredOn = [x.plan.bills[0].date]; }, 976.85);
run('native observed paid unknown bill', x => { x.plan.bills[0].amount = null; x.opts.currentPeriodActuals.representedActuals.push({ id: 'service', date: '2026-08-24', actual: 17.23, postedOn: fx.AS_OF }); }, 976.85);
run('native overdue unknown commitment carry', x => { x.plan.commitments[0].amount = null; x.plan.commitments[0].date = '2026-08-18'; }, null, 'remaining-cash-unknown');
run('native overdue unknown once bill carry', x => { x.plan.bills[0].amount = null; x.plan.bills[0].date = '2026-08-10'; }, null, 'remaining-cash-unknown');
run('native omitted future income', x => { x.plan.income[1].amount = null; x.opts.incomeOccurrenceAdjust = stream => stream.id === 'partner' ? { omit: true } : null; }, 696.43);
run('native adjusted future income establishes amount', x => { x.plan.income[1].amount = null; x.opts.incomeOccurrenceAdjust = stream => stream.id === 'partner' ? { amount: 263.19, confidence: 'confirmed' } : null; }, 959.62);
run('native additional future income unknown', x => { x.opts.additionalIncomeEvents = [{ id: 'additional', kind: 'income', date: '2026-08-26', amount: null, confidence: 'confirmed' }]; }, null, 'income-unavailable');
run('native authored zero bill cannot bypass payer proof', x => { x.plan.bills[0].amount = 0; x.plan.bills[0].payingAccount = 'unconfirmed-account'; }, null);
run('native authored zero commitment cannot bypass payer proof', x => { x.plan.commitments[0].amount = 0; x.plan.commitments[0].payingAccount = 'unconfirmed-account'; }, null);
const minimum = (x, amount, payer = 'chequing-a') => { x.plan.obligations.push({ id: 'future-minimum', label: 'Invented required payment',
  effect: 'payment', debtId: 'travelvisa', frequency: 'once', date: '2026-08-25', amount, confidence: 'confirmed', payingAccount: payer }); };
run('native required payment known', x => minimum(x, 13.17), 946.45);
run('native required payment null', x => minimum(x, null), null, 'remaining-cash-unknown');
run('native required payment nonfinite', x => minimum(x, NaN), null, 'remaining-cash-unknown');
run('native zero required payment requires no payer proof', x => minimum(x, 0, 'unconfirmed-account'), 959.62);
run('native required payment paid by Weekly', x => minimum(x, 13.17, 'chequing-b'), 959.62);
run('native required payment paid by Savings', x => minimum(x, 13.17, 'savings'), 959.62);
console.log(`PASS Bills native requirements: ${checks} independent assertions across ${cases.length} cases`);
module.exports = { cases };
