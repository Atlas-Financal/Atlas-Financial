'use strict';
// Finish-line audit finding 1 (#821): a paycheque is counted once. While a
// scheduled income occurrence is unproven, an unlinked income-category credit
// near it is never added beside it: the scheduled occurrence stays relied
// upon at plan, the credit is listed To confirm and adds nothing, so Balance
// After Deductions is never a paycheque high.
//
// Real path: invented Lunch Money rows -> provider-observe -> live overlay ->
// Forecast.recommend (test/acceptance/harness.js). Invented household:
// biweekly pay 1,400 from Oct 9 (Oct 9 - Oct 22, Oct 23 - Nov 5), Groceries
// 300 + Eating out 100, so one paycheque less the 400 budget is 1,000.
// Expectations are hand-derived; no household figure enters this file.
//
//   node test/test-paycheque-once.js
const assert = require('node:assert/strict');
const H = require('./acceptance/harness.js');
const F = require('../public/forecast.js');

const pay = o => H.lm(Object.assign({ date: '2026-10-09', amount: -1400, category: 'Payroll',
  account: 'chequing-a', payee: 'Invented employer' }, o));
function periods(asOf, txs, patch) {
  const w = H.baseWorld(asOf);
  w.transactions = txs;
  if (patch) patch(w);
  const { data, packet, error } = H.dataOf(w);
  assert.equal(error, null, 'the observation is applied');
  const advice = F.recommend(data.plan, data.meta.asOf, { currentPeriodActuals: packet, debts: data.debts });
  const at = start => advice.payPeriodViews.find(p => p.start === start);
  return { current: at('2026-10-09'), next: at('2026-10-23'), advice, data };
}
const held = p => (p.income || []).filter(r => r.otherIncome === true && r.toConfirm === true);
const counted = p => (p.income || []).filter(r => r.otherIncome === true && r.toConfirm !== true);
const payRow = (p, date) => (p.income || []).find(r => r.id === 'payroll' && r.date === date);

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS  ' + name); }
  catch (err) { failures++; console.log('  FAIL  ' + name + ' -- ' + String(err && err.message || err).split('\n')[0]); }
}

check('control: a matched paycheque is counted once, as before', () => {
  const { current } = periods('2026-10-14', [pay({})]);
  assert.equal(current.balanceAfterDeductions, 1000, '1,400 - 400');
  assert.equal(held(current).length + counted(current).length, 0, 'no Other income row');
  assert.equal(payRow(current, '2026-10-09').settlement, 'represented');
});

for (const [name, txs, patch] of [
  ['bank text does not match the rule', [pay({ payee: 'DIRECT DEP 4471' })]],
  ['paid into the other chequing account', [pay({ account: 'chequing-b' })]],
  ['paid in two legs', [pay({ amount: -700, payee: 'PAY 1/2' }), pay({ amount: -700, payee: 'PAY 2/2' })]],
  ['the stream has no identity rule', [pay({})], w => { w.identityRules = []; }],
]) {
  check('trigger: ' + name + ' -> counted once, the credit held To confirm', () => {
    const { current } = periods('2026-10-14', txs, patch);
    assert.equal(current.balanceAfterDeductions, 1000, 'never 2,400 (a paycheque high)');
    const row = payRow(current, '2026-10-09');
    assert.ok(row && row.toConfirm !== true && row.amount === 1400, 'the scheduled pay stays relied upon at plan');
    assert.equal(counted(current).length, 0, 'no unlinked credit is added beside it');
    assert.equal(held(current).reduce((s, r) => s + r.amount, 0), 1400, 'the credit is listed, To confirm');
    assert.ok(held(current).every(r => r.notReliedUponReason === 'possible-scheduled-income-receipt'));
  });
}

check('trigger: paid a day early into the current period -> neither period is a paycheque high', () => {
  // Oct 23 pay arrives Oct 22 under bank text no rule matches.
  const { current, next } = periods('2026-10-22', [pay({}), pay({ date: '2026-10-22', payee: 'DIRECT DEP' })]);
  assert.equal(current.balanceAfterDeductions, 1000, 'current: one paycheque (Oct 9)');
  assert.equal(next.balanceAfterDeductions, 1000, 'next: one paycheque (Oct 23)');
  assert.equal(held(current).length, 1, 'the early credit is To confirm');
});

check('trigger: paid two days late, after its own day -> counted once', () => {
  // The Oct 9 pay arrives Oct 11 under unmatched text.
  const { current } = periods('2026-10-14', [pay({ date: '2026-10-11', payee: 'DIRECT DEP' })]);
  assert.ok(current.balanceAfterDeductions <= 1000, 'never 2,400');
  assert.equal(counted(current).length, 0);
});

check('boundary: a credit four days from any pay date is ordinary Other income, counted', () => {
  // Oct 13 is four days after Oct 9 and ten before Oct 23.
  const { current } = periods('2026-10-14', [pay({}), pay({ date: '2026-10-13', amount: -50, payee: 'Invented gift' })]);
  assert.equal(current.balanceAfterDeductions, 1050, 'the 50 gift counts');
  assert.equal(counted(current).length, 1);
  assert.equal(held(current).length, 0);
});

check('a proven paycheque holds nothing: a bonus beside it is ordinary Other income', () => {
  const { current } = periods('2026-10-14', [pay({}), pay({ date: '2026-10-10', amount: -200, payee: 'Invented bonus' })]);
  assert.equal(current.balanceAfterDeductions, 1200, '1,400 + 200 - 400');
  assert.equal(counted(current).length, 1);
});

check('share gate: a small gift two days before a pay that has not arrived is ordinary Other income', () => {
  // As of Oct 21 the Oct 23 pay is unproven; a 50 gift on Oct 21 is far below half of 1,400.
  const { current } = periods('2026-10-21', [pay({}), pay({ date: '2026-10-21', amount: -50, payee: 'Invented gift' })]);
  assert.equal(current.balanceAfterDeductions, 1050, 'the gift counts');
  assert.equal(held(current).length, 0);
});
check('share gate: a gift beside an unmatched paycheque is held with it (understates, never overstates)', () => {
  const { current } = periods('2026-10-14', [pay({ payee: 'DIRECT DEP' }), pay({ date: '2026-10-10', amount: -50, payee: 'Invented gift' })]);
  assert.equal(current.balanceAfterDeductions, 1000, 'one paycheque; the gift waits To confirm');
  assert.equal(held(current).length, 2);
});

// Review repair (overnight reviewer + Codex r4534951872 on 2dbc576): proof is
// read in every role. A proven pay in a CLOSED period holds nothing, so an
// unrelated bonus beside it still counts after the period closes.
for (const [label, asOf] of [['boundary day (the first day after the period closes)', '2026-10-23'],
  ['a week after it closes', '2026-10-30']]) {
  check('closed period: a proven pay plus an 800 bonus reads 2,200 on ' + label, () => {
    const { current: closed } = periods(asOf, [pay({}), pay({ date: '2026-10-10', amount: -800, payee: 'Invented bonus' }),
      pay({ date: '2026-10-23' })]);
    assert.equal(closed.balanceAfterDeductions, 2200, '1,400 + 800, closed period (observed spend 0)');
    assert.equal(held(closed).length, 0, 'nothing held beside a proven pay');
    assert.equal(counted(closed).length, 1, 'the bonus counts once');
  });
}
check('closed period: an unmatched paycheque is still held after its period closes', () => {
  const { current: closed } = periods('2026-10-30', [pay({ payee: 'DIRECT DEP' }), pay({ date: '2026-10-23' })]);
  assert.equal(closed.balanceAfterDeductions, 1400, 'one paycheque, never 2,800');
  assert.equal(held(closed).length, 1);
});

// Builder self-check (lead, 2026-11-11): equal timestamp, repeat, fixed context.
check('equal timestamp: an unmatched credit on the same day as a matched pay is ordinary Other income', () => {
  // The Oct 9 pay is proven by its identity, so a second same-day credit is not that pay.
  const { current } = periods('2026-10-14', [pay({}), pay({ amount: -100, payee: 'Invented refund co' })]);
  assert.equal(current.balanceAfterDeductions, 1100);
});
check('repeat: two consecutive unmatched paycheques each count once in their own period', () => {
  // As of Oct 23 the Oct 9 period is closed: it reports observed spend (0),
  // so its result is the one paycheque, 1,400, never 2,800.
  const { current: closed, next: now } = periods('2026-10-23', [pay({ payee: 'DIRECT DEP' }), pay({ date: '2026-10-23', payee: 'DIRECT DEP' })]);
  assert.equal(closed.balanceAfterDeductions, 1400, 'closed period: one paycheque');
  assert.equal(now.balanceAfterDeductions, 1000, 'current period: one paycheque less the budget');
  assert.equal(held(closed).length + held(now).length, 2, 'each unmatched credit is To confirm');
});
check('fixed context: the same input observed twice publishes the same income rows', () => {
  const txs = [pay({ payee: 'DIRECT DEP 4471' })];
  const a = periods('2026-10-14', txs).current, b = periods('2026-10-14', txs).current;
  assert.deepEqual(a.income, b.income);
  assert.equal(a.balanceAfterDeductions, b.balanceAfterDeductions);
});

console.log(failures ? `\n${failures} failure(s)` : '\nall cases pass');
process.exit(failures ? 1 : 0);
