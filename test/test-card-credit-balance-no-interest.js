'use strict';
/* A card in credit (balance below zero, after an overpayment or a refund)
 * earns no borrower APR. Invented case, 20% APR, as-of 2026-10-14:
 *
 *   credit -100 for 30 days     -> still -100, interest 0
 *     (before the fix: -100 * (1 + 0.20/365)^30 = about -101.66, i.e.
 *      the household was shown earning fictional interest, and the
 *      assistant packet's 12-month debt trajectory drifted from -100 to
 *      about -113)
 *   owed 100, overpaid 150 on day 10 -> interest accrues on the 100 only
 *     until the payment, then the -50-ish credit stays flat
 *   owed 100, never paid            -> unchanged borrower interest
 *     (control: 100 * ((1 + 0.20/365)^30 - 1) = about 1.66)
 *
 * Expected values are hand-derived here, independent of the engine.
 */
const assert = require('node:assert/strict');
const H = require('./acceptance/harness');
const F = require('../public/forecast');
const A = require('../scripts/assistant-packet');
const RATE = 20, DAILY = RATE / 100 / 365;
const cents = n => Math.round(n * 100);
function world(balance, payment) {
  const w = H.baseWorld();
  w.accounts.push({ id: 'travelvisa', providerId: 9004, role: 'revolving-credit', collection: 'debts', label: 'Invented card', value: balance });
  w.debts = [{ id: 'travelvisa', label: 'Invented card', structure: 'Revolving', secured: false, balance,
    pending: 0, rate: RATE, limit: 2000, statementCloseDay: 17 }];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  if (payment) w.planPatch = plan => { plan.obligations.push({ id: 'overpay', label: 'Invented overpayment', debtId: 'travelvisa',
    effect: 'payment', frequency: 'once', date: payment.date, amount: payment.amount, payingAccount: 'chequing-a', confidence: 'confirmed' }); };
  const { data, packet, error } = H.dataOf(w);
  assert.equal(error, null);
  return { data, packet, asOf: w.asOf };
}
function walk(x, days) {
  const proj = F.projectDebts(x.data.plan, x.data.debts, x.asOf, { horizonDays: days, currentPeriodActuals: x.packet });
  const at = day => proj.marks.find(m => m.day === day).debts.find(d => d.id === 'travelvisa');
  return { proj, at };
}
let checks = 0;
const eq = (a, b, m) => { assert.equal(a, b, m); checks++; };

// 1. A credit balance stays exactly where it is.
{
  const { at } = walk(world(-100), 30);
  eq(cents(at(30).balance), -10000, 'a -100 credit is still -100 after 30 days');
  eq(cents(at(30).interest), 0, 'no interest is earned on a credit balance');
}
// 2. Control: money owed still accrues borrower interest, unchanged.
{
  const { at } = walk(world(100), 30);
  const hand = 100 * (Math.pow(1 + DAILY, 30) - 1);
  eq(cents(at(30).interest), cents(hand), 'owed balance interest = 100 x ((1 + 0.20/365)^30 - 1)');
}
// 3. A posted refund larger than the balance owed (observed by the bank
// feed) leaves the card in credit: owed 100, refund 150 -> credit -50,
// which then stays flat with no interest.
{
  const w = H.baseWorld();
  w.accounts.push({ id: 'travelvisa', providerId: 9004, role: 'revolving-credit', collection: 'debts', label: 'Invented card', value: -50 });
  w.debts = [{ id: 'travelvisa', label: 'Invented card', structure: 'Revolving', secured: false, balance: 100,
    pending: 0, rate: RATE, limit: 2000, statementCloseDay: 17 }];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    H.lm({ date: '2026-10-12', amount: -150, category: 'Refund', account: 'travelvisa', providerAccountId: 9004, payee: 'Invented store refund' })];
  const { data, packet, error } = H.dataOf(w);
  assert.equal(error, null);
  const opening = data.debts.find(d => d.id === 'travelvisa').balance;
  eq(cents(opening), -5000, 'the observed card balance after the refund is a 50 credit');
  const proj = F.projectDebts(data.plan, data.debts, w.asOf, { horizonDays: 60, currentPeriodActuals: packet });
  for (const day of [30, 60]) {
    const d = proj.marks.find(m => m.day === day).debts.find(r => r.id === 'travelvisa');
    eq(cents(d.balance), -5000, 'the refund credit stays -50 at day ' + day);
    eq(cents(d.interest), 0, 'no interest on the refund credit at day ' + day);
  }
}
// Control: a planned overpayment is capped at what is owed, so the
// projection never manufactures a credit (owed 100 -> 0, never -50).
{
  const x = world(100, { date: '2026-10-24', amount: 150 });
  const d = walk(x, 30).at(30);
  eq(cents(d.balance), 0, 'a planned overpayment stops at zero');
}
// 4. The assistant packet (ChatGPT / Talk) trajectory keeps a credit flat.
{
  const x = world(-100);
  const p = A.buildPacket({ data: x.data, periods: null, questionsMarkdown: '', now: '2026-10-14T18:00:00Z', env: {} });
  const months = p.planning.trajectory.months || [];
  assert.ok(months.length > 0, 'the trajectory publishes months'); checks++;
  for (const m of months) eq(cents(m.debt.consumer), -10000, 'consumer debt stays -100 in ' + (m.month || m.end || 'a month'));
}
console.log(`  PASS  a card credit balance earns no borrower interest (${checks} checks)`);
