'use strict';
/* #962 D3 follow-up: a near-due bill debit whose payee also carries a
 * merchant-category identity is counted once.
 *
 * #965 holds a debit carrying a bill's identity within days of its due date
 * (same spending cycle) out of household spending: the bill's in-period
 * reserve already deducts it. Main's H1 wrapper (#902,
 * merchantLabelUnbudgetedResult) re-routed that hold to confirmation /
 * household spending whenever the payee had a merchant-category identity
 * (grocery, fuel, dog food, Dale guilt-free merchant), because the reason
 * was not in MERCHANT_LABEL_KEPT_BILL_REASONS. The bill also stayed
 * reserved, so the same money was deducted twice.
 *
 * Proof: invented raw Lunch Money payload -> harness observe ->
 * Forecast.recommend. The expected figures are hand arithmetic against a
 * control world with the same bill and no debit: a debit the bill reserve
 * stands in for leaves Balance After Deductions equal to the control; a
 * debit counted as spending lowers it by the debit amount exactly once. The
 * classifier is read only to name the route. H1's genuine merchant-purchase
 * cases (no bill identity, or across a payday) must stay counted as before.
 * Invented numbers; the merchant keys are the public identity constants in
 * public/forecast.js.
 *
 * `node test/test-bill-near-due-merchant-identity.js`
 */
const F = require('../public/forecast.js');
const H = require('./acceptance/harness.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const AMOUNT = 90;
const payroll = () => H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a',
  payee: 'Invented employer' });

// One monthly bill of 90 whose identity payee is `billPayee`, due on `day`.
function run({ billPayee, day = 12, debit = null, asOf = '2026-10-14' }) {
  const w = H.baseWorld(asOf);
  w.bills = [{ id: 'bill', label: 'Invented bill', amount: AMOUNT, frequency: 'monthly', day,
    confidence: 'confirmed', payee: billPayee }];
  w.transactions = [payroll()].concat(debit ? [H.lm({ account: 'chequing-a', ...debit })] : []);
  const r = H.observe(w);
  if (r.error) throw r.error;
  const rec = F.recommend(r.plan, w.asOf, { currentPeriodActuals: r.packet });
  const periods = (rec.defaultView && rec.defaultView.calendarPeriods) || [];
  const period = periods.find(p => p.start <= w.asOf && p.end >= w.asOf) || null;
  const other = ((period && period.householdBudget) || []).find(row => row && row.otherSpending) || null;
  const tx = debit ? (r.packet.transactions || []).find(t => t.date === debit.date
    && Math.abs(Number(t.amount)) === AMOUNT) : null;
  const cls = tx ? F.classifyCurrentPeriodTransaction(tx, r.plan, { packet: r.packet, currentPeriodActuals: r.packet }) : null;
  const bills = periods.flatMap(p => p.bills || []).filter(b => b.id === 'bill');
  return { period, bad: period && period.balanceAfterDeductions,
    other: other && typeof other.spent === 'number' ? other.spent : 0, tx, cls, bills };
}

const MERCHANTS = [
  ['grocery', 'WALMART'],
  ['fuel', 'PITT MEADOWS CE'],
  ['dog food', 'SURREY MEAT'],
  ['Dale guilt-free merchant', 'CURSOR'],
];

console.log('=== 1. merchant-identity bill payee paid 2 days early: counted once ===');
for (const [kind, payee] of MERCHANTS) {
  for (const category of ['Utilities', 'Groceries', 'Fuel']) {
    const control = run({ billPayee: payee });
    const res = run({ billPayee: payee, debit: { date: '2026-10-10', amount: AMOUNT, category, payee } });
    const tag = `${kind} (${category})`;
    ok(res.tx && res.tx.nearDueBillCandidate && res.tx.nearDueBillCandidate.date === '2026-10-12',
      `${tag}: the observer tags the debit for the Oct 12 occurrence`, JSON.stringify(res.tx && res.tx.nearDueBillCandidate));
    ok(res.cls && res.cls.reason === 'near-due-bill-unconfirmed' && res.cls.householdSpending === false,
      `${tag}: held on the bill, not household spending`, res.cls && res.cls.reason);
    ok(res.other === 0, `${tag}: Other spending is 0, not ${AMOUNT}`, String(res.other));
    ok(control.bad === 910, `${tag}: control Balance After Deductions is 1400 - 400 - 90 = 910`, String(control.bad));
    ok(res.bad === control.bad, `${tag}: Balance After Deductions equals the control (reserve deducts it once)`,
      `${res.bad} vs ${control.bad}`);
    const bill = res.bills.find(b => b.date === '2026-10-12') || res.bills[0];
    ok(bill && bill.status !== 'paid' && Number(bill.remaining) === AMOUNT,
      `${tag}: the bill stays unpaid and reserved at ${AMOUNT}`, bill && `${bill.status} ${bill.remaining}`);
  }
}

// A merchant purchase with no bill identity is never tagged near-due, so the
// new kept reason cannot reach it. H1's own re-routing is covered by
// test-lunchmoney-category-over-merchant.js.
console.log('=== 2. a merchant purchase without a bill identity stays counted ===');
for (const [kind, payee] of MERCHANTS) {
  // The bill belongs to a different payee: the merchant debit is a purchase.
  const control = run({ billPayee: 'Invented hydro' });
  const res = run({ billPayee: 'Invented hydro',
    debit: { date: '2026-10-10', amount: AMOUNT, category: 'Utilities', payee } });
  ok(!(res.tx && res.tx.nearDueBillCandidate), `${kind}: no bill identity, no near-due tag`);
  ok(res.cls && res.cls.householdSpending === true && res.cls.reason !== 'near-due-bill-unconfirmed',
    `${kind}: household spending, never a bill hold`, res.cls && res.cls.reason);
  ok(res.other === AMOUNT, `${kind}: Other spending is ${AMOUNT}`, String(res.other));
  ok(res.bad === control.bad - AMOUNT, `${kind}: Balance After Deductions falls by ${AMOUNT} once`,
    `${res.bad} vs ${control.bad} - ${AMOUNT}`);
}

console.log('=== 3. across a payday the merchant-identity debit stays counted in its own period ===');
for (const [kind, payee] of MERCHANTS) {
  // Debit Oct 20 in the Oct 9-22 period; the occurrence is Oct 23 (next period).
  const control = run({ billPayee: payee, day: 23, asOf: '2026-10-21' });
  const res = run({ billPayee: payee, day: 23, asOf: '2026-10-21',
    debit: { date: '2026-10-20', amount: AMOUNT, category: 'Utilities', payee } });
  ok(res.cls && res.cls.householdSpending === true, `${kind}: household spending in its own period`,
    res.cls && res.cls.reason);
  ok(res.other === AMOUNT, `${kind}: Other spending is ${AMOUNT}`, String(res.other));
  ok(res.bad === control.bad - AMOUNT, `${kind}: Balance After Deductions falls by ${AMOUNT} once`,
    `${res.bad} vs ${control.bad} - ${AMOUNT}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll near-due merchant-identity checks passed.');
process.exit(failures ? 1 : 0);
