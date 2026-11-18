'use strict';
/* Lead ruling on #1355 (owner Dale named the mortgage): D2's fixed-amount remainder rule extends to a plain payment
 * obligation whose amount is derived fixed from its Lunch Money payment history, by the same derivation as bills
 * (provider-observe derivedAmountFixedBills, now also returning obligationIds). A card minimum (statement
 * occurrences), a capitalising or non-cash leg (the HELOC shape), a once obligation and a sent minimum are never
 * fixed.
 *
 * Path: invented raw Lunch Money payloads (live window plus the 200-day history read) -> scripts/provider-observe.js
 * -> scripts/live-plan.js (acceptance harness) -> served plan -> Forecast.recommend.
 *
 * Invented world: the acceptance harness base world as of Wed 2026-10-14 (pay period Oct 9-22) and one invented
 * biweekly $800 mortgage due Fri Oct 9, paid from chequing-a, identified by its payee. History: three completed
 * $800 payments (Aug 28, Sep 11, Sep 25), so by hand it derives fixed. Oct 9 is the current occurrence, so its own
 * payment never decides. By hand: paid 300 of 800 leaves 800 - 300 = 500 still to pay this period; unpaid leaves 800;
 * paid in full leaves 0.
 *
 * `node test/test-derived-amount-fixed-obligation.js`
 */
const H = require('./acceptance/harness.js');
const F = require('../public/forecast.js');
const Memory = require('../scripts/server-observation-memory');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const MORTGAGE = { id: 'mortgage', debtId: 'mortgage', effect: 'payment', label: 'Invented mortgage', frequency: 'biweekly',
  anchor: '2026-10-09', amount: 800, confidence: 'confirmed', payingAccount: 'chequing-a' };
const pay = (amount, date) => H.lm({ date, amount, account: 'chequing-a', payee: 'Invented mortgage co', category: 'Utilities' });
const HISTORY = ['2026-08-28', '2026-09-11', '2026-09-25'];

function world(paid, { history = HISTORY.map(d => pay(800, d)), obligation = MORTGAGE, withDebts = true } = {}) {
  const w = H.baseWorld();
  w.obligations = [obligation];
  w.debts = [{ id: 'mortgage', label: 'Invented mortgage', balance: 200000, rate: 5, payment: 800, confidence: 'confirmed' }];
  w.identityRules = (w.identityRules || []).concat([{ eventId: 'mortgage', payeePattern: 'Invented mortgage co',
    atlasAccountId: 'chequing-a', direction: 'debit' }]);
  w.transactions = paid ? [pay(paid, '2026-10-09')] : [];
  // As in production, the 200-day read overlaps the live window, so it also carries the current payment.
  if (history) w.amountHistory = { transactions: history.concat(w.transactions) };
  const r = H.observe(w);
  if (r.error) throw r.error;
  const served = r.plan.obligations.find(o => o.id === 'mortgage');
  // The Budget page's path supplies debts, so the debt walk caps the obligation (Codex P1 on #1369).
  const rec = F.recommend(r.plan, w.asOf, { currentPeriodActuals: r.packet, ...(withDebts ? { debts: w.debts } : {}) });
  const period = rec.defaultView.calendarPeriods.find(p => p.start <= w.asOf && p.end >= w.asOf);
  const row = (period.bills || []).find(b => b.id === 'mortgage');
  return { fixed: served.amountFixed === true, row, remaining: period.remainingBills, day0: rec.sim.daily[0].balance, rec };
}

console.log('1. A plain payment obligation derived fixed keeps its remainder (D2 for obligations)');
{
  const full = world(800), part = world(300), none = world(0);
  ok(full.fixed && part.fixed && none.fixed, 'three completed $800 payments: the mortgage derives fixed (the current payment never decides)');
  ok(part.row && part.row.status === 'still due' && part.row.actual === 300 && part.row.remaining === 500 && part.remaining === 500,
    'paid 300 of 800: still due, 300 paid, 500 remaining, and this period holds 500', part.row && JSON.stringify([part.row.status, part.row.actual, part.row.remaining, part.remaining]));
  ok(full.row && full.row.status === 'PAID' && full.row.remaining === 0 && full.remaining === 0, 'paid in full: PAID, nothing held');
  ok(none.row && none.row.status === 'still due' && none.remaining === 800, 'unpaid: still due for 800, as before');
  // The walk spreads what it holds about the same way for the remainder as for the whole payment, so by hand the
  // remainder's share of the unpaid hold is about 500 / 800 = 0.625 (the weekly cap's rounding moves it by under
  // 0.001); a double-counted payment would give about 200 / 800 = 0.25.
  const share = (full.day0 - part.day0) / (full.day0 - none.day0);
  ok(Math.abs(share - 500 / 800) < 0.005, 'with debts supplied (the Budget page\'s path) the cash walk holds 500 of 800, never 200',
    String(share));
  const noDebts = world(300, { withDebts: false });
  ok(Math.abs(noDebts.day0 - part.day0) < 1e-9, 'the same hold with and without debts: the debt walk\'s cap does not count the payment twice',
    `${noDebts.day0} vs ${part.day0}`);
}

console.log('2. Without the derivation, the incumbent reading stands');
{
  const noHistory = world(300, { history: null });
  ok(!noHistory.fixed && noHistory.row && noHistory.row.status === 'PAID' && noHistory.remaining === 0,
    'no history read: not fixed, paid 300 reads PAID and nothing is held (today\'s behaviour)');
  const varies = world(300, { history: [pay(800, '2026-08-28'), pay(750, '2026-09-11'), pay(800, '2026-09-25')] });
  ok(!varies.fixed && varies.row.status === 'PAID', 'a history that varies (750 once): not fixed, PAID');
  const hand = world(300, { history: null, obligation: { ...MORTGAGE, amountFixed: true } });
  ok(!hand.fixed && hand.row.status === 'PAID', 'a hand amountFixed mark on the obligation is dropped: PAID');
}

console.log('3. Obligations that are never fixed');
{
  const card = world(300, { obligation: { ...MORTGAGE, statementOccurrences: [] } });
  ok(!card.fixed, 'an obligation with statement occurrences (a card minimum): never fixed');
  const heloc = world(300, { obligation: { ...MORTGAGE, effect: 'capitalise', nonCash: true } });
  ok(!heloc.fixed, 'a capitalising, non-cash obligation (the HELOC shape): never fixed');
  const once = world(300, { obligation: { ...MORTGAGE, frequency: 'once', date: '2026-10-09' } });
  ok(!once.fixed, 'a once obligation: never fixed');
  // Forecast's own guard: a sent-minimum or statement event is never a fixed partial payment, whatever its flag.
  const ev = { kind: 'obligation', id: 'mortgage', date: '2026-10-09', amountFixed: true, confidence: 'confirmed', effect: 'payment' };
  const observed = new Map([['mortgage@2026-10-09', { actual: 300, entries: 1 }]]);
  ok(F.fixedBillPartialPayment && F.fixedBillPartialPayment(ev, 800, observed)
    && !F.fixedBillPartialPayment({ ...ev, minimumPayment: { amount: 300 } }, 800, observed)
    && !F.fixedBillPartialPayment({ ...ev, occurrenceKey: 'mortgage@2026-10-09' }, 800, observed)
    && !F.fixedBillPartialPayment({ ...ev, cashMinimum: true }, 800, observed),
    'the remainder rule takes a plain payment obligation, never a minimum, statement or cash-minimum event');
}

console.log('4. Replay memory keeps the obligation ids, and nothing else of the history');
{
  const rec = Memory.amountFixedDerivation({ source: 'lunchmoney-payment-history', status: 'complete',
    window: { startDate: '2026-03-28', endDate: '2026-10-14' }, billIds: [], obligationIds: ['mortgage'] });
  ok(JSON.stringify(rec.obligationIds) === JSON.stringify(['mortgage']) && rec.status === 'complete', 'a clean record keeps obligationIds');
  const legacy = Memory.amountFixedDerivation({ source: 'lunchmoney-payment-history', status: 'complete',
    window: { startDate: '2026-03-28', endDate: '2026-10-14' }, billIds: ['x'] });
  ok(legacy.status === 'complete' && JSON.stringify(legacy.obligationIds) === '[]', 'a record without obligationIds (from #1355) fixes no obligation');
  const bad = Memory.amountFixedDerivation({ source: 'lunchmoney-payment-history', status: 'complete',
    window: { startDate: '2026-03-28', endDate: '2026-10-14' }, billIds: [], obligationIds: [7] });
  ok(bad.status === 'unavailable' && bad.obligationIds.length === 0, 'a malformed obligation id fixes nothing');
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll derived amountFixed obligation checks passed.');
