'use strict';
/* A future-dated one-off income the Budget already counts as received (here,
 * settled early by #927's unique exact-amount credit) is not added again by
 * the forward walk (#857 finding). Grok Bot's conditions (Plan #6 thread):
 *   (a) the walk reads the Budget's own received decision (one decision);
 *   (b) only a posted credit counts as received; pending stays income to come;
 *   (c) if the decision reverts (the credit is gone), the walk adds it back;
 *   (d) the income counts exactly once across the Budget and the walk.
 *
 * Invented household from test/acceptance/harness.js: salary 1,400 received
 * Oct 9, as-of Oct 14, cycle Oct 9 - Oct 22. The owner plans a 175 one-off
 * refund for Oct 20.
 *   posted:  it arrives early, Oct 12, as an unflagged credit of exactly 175,
 *            so the Bills account reads 2,175 (2,000 + 175).
 *   pending: the same credit, still pending; the account reads 2,000.
 *   none:    no credit; the account reads 2,000.
 * Hand-derived expectations:
 *   Budget income this period: 1,400 + 175 = 1,575 in every world.
 *   Walk: posted adds no Oct 20 refund (the 175 is already in the 2,175);
 *         pending and none add 175 on Oct 20.
 *   Once overall: posted starts 175 higher and adds 175 less, so its walk
 *   ending equals the none world's ending exactly.
 * No household figure enters this file.
 */
const assert = require('node:assert/strict');
const H = require('./acceptance/harness.js');
const F = require('../public/forecast.js');

function world(credit) {
  const w = H.baseWorld();
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  w.categories.push({ id: 112, name: 'Reimbursement' });
  w.income.push({ id: 'refund', label: 'Invented tax refund', frequency: 'once', date: '2026-10-20', amount: 175,
    incomeClass: 'other', confidence: 'confirmed' });
  w.accounts.find(a => a.id === 'chequing-a').value = credit === 'posted' ? 2175 : 2000;
  if (credit) {
    w.transactions.push(H.lm({ date: '2026-10-12', amount: -175, category: 112, account: 'chequing-a',
      payee: 'Invented tax office', pending: credit === 'pending' }));
  }
  return w;
}
function run(credit) {
  const { data, packet, error } = H.dataOf(world(credit));
  assert.equal(error == null, true, 'the observation is applied');
  const advice = F.recommend(data.plan, '2026-10-14', { debts: data.debts, currentPeriodActuals: packet });
  const view = advice.payPeriodViews.find(r => r.start === '2026-10-09');
  return {
    refundEvents: (advice.sim.events || []).filter(e => e.id === 'refund' && e.kind === 'income'),
    incomeTotal: view.incomeTotal,
    ending: advice.sim.ending,
  };
}
const cents = n => Math.round(Number(n) * 100);
let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };

const posted = run('posted');
const pending = run('pending');
const none = run(null);

for (const [name, r] of [['posted', posted], ['pending', pending], ['none', none]]) {
  check(cents(r.incomeTotal) === 157500, `${name}: Budget income this period is 1,400 + 175 = 1,575 (got ${r.incomeTotal})`);
}
check(posted.refundEvents.length === 0,
  `(a)(d) posted: the walk adds no Oct 20 refund the Budget already received (got ${JSON.stringify(posted.refundEvents)})`);
check(pending.refundEvents.length === 1 && pending.refundEvents[0].date === '2026-10-20'
    && cents(pending.refundEvents[0].amount) === 17500,
  `(b) pending: the refund stays income to come, 175 on Oct 20 (got ${JSON.stringify(pending.refundEvents)})`);
check(none.refundEvents.length === 1 && none.refundEvents[0].date === '2026-10-20'
    && cents(none.refundEvents[0].amount) === 17500,
  `(c) no credit: the walk adds the planned 175 on Oct 20 (got ${JSON.stringify(none.refundEvents)})`);
check(cents(posted.ending) === cents(none.ending),
  `(d) counted once: the posted world's walk ending equals the no-credit world's (${posted.ending} vs ${none.ending})`);

console.log(`  PASS  the forward walk follows the Budget's credit-settled income decision (${checks} checks)`);
