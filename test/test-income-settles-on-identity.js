'use strict';
/* C3 (acceptance 1.9): an unrelated receipt never settles an expected
 * one-off income, and the expectation and an unlinked receipt are never
 * both counted in the Payday balance.
 *
 * Rules (lead ruling on #857):
 *   1. an identity-rule link on representedActuals settles the expectation;
 *   2. else exactly one posted unlinked Other Income receipt on the same
 *      date for the same amount to the cent settles it (as on main);
 *   3. any other unlinked receipt in its window leaves the expectation
 *      listed at its planned amount, To confirm and not counted;
 *   4. with no unlinked receipt in its window it is counted as planned.
 *
 * Invented figures only. Expectations are hand-derived: payroll 1,000 is
 * the only other income in the Aug 28 - Sep 10 window; the Payday balance
 * is that window's income identity. Expected rebate 200 on Sep 3; as-of
 * Sep 9.
 *
 * `node test/test-income-settles-on-identity.js`
 */
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const AS_OF = '2026-09-09';
const DATE = '2026-09-03';
const PAYROLL = 1000, REBATE = 200;
const plan = (withRebate = true) => ({
  defaults: { targetBuffer: 0 },
  startingCash: { breakdown: [{ id: 'chequing-a', label: 'Invented bills account', value: 2000, class: 'spendable' }] },
  opening: { asOf: AS_OF, representedEvents: [] },
  income: [{ id: 'payroll', frequency: 'biweekly', anchor: '2026-08-14', amount: PAYROLL, confidence: 'confirmed' }]
    .concat(withRebate ? [{ id: 'rebate', label: 'Invented rebate', frequency: 'once', date: DATE, amount: REBATE,
      incomeClass: 'other', confidence: 'confirmed' }] : []),
  bills: [], obligations: [], commitments: [], budget: { categories: [] },
});
const tx = (id, date, amount, extra = {}) => Object.assign({ id, date, amount: -amount, isIncome: true,
  categoryLabel: 'other income', displayedPayee: 'Invented payer', accountRole: 'household-cash' }, extra);
const link = (txId, amount) => ({ id: 'rebate', date: DATE, actual: -amount, postedOn: DATE, transactionId: txId });
const packet = (transactions, representedActuals = []) => ({
  schema: 'atlas-current-period-actuals/v1', observationAsOf: AS_OF,
  coverageStart: '2026-07-31', coverageThrough: AS_OF, transactionCoverage: 'complete', pendingCoverage: 'complete',
  representedActuals, transactions,
});
const view = (p, pkt) => {
  const advice = F.recommend(p, AS_OF, { targetBuffer: 0, debts: [], currentPeriodActuals: pkt });
  const v = (advice.payPeriodViews || []).find(x => x.start <= DATE && x.end >= DATE);
  const rows = (v && v.income) || [];
  return { v, rows, rebate: rows.find(r => r && r.id === 'rebate') || null,
    receipts: rows.filter(r => r && String(r.id).startsWith('other-income:')) };
};
const held = r => r && r.status !== 'received' && r.actual == null && r.toConfirm === true
  && r.notReliedUpon === true && r.planned === REBATE;

console.log('\n=== control ===');
{
  const base = view(plan(false), packet([]));
  ok(base.v.available === PAYROLL, 'no rebate, no receipt: Payday balance is payroll only', String(base.v.available));
  const none = view(plan(), packet([]));
  ok(none.rebate && none.rebate.status === 'arriving' && !none.rebate.toConfirm
      && none.v.available === PAYROLL + REBATE,
    'rule 4: with no receipt in its window the rebate is counted as planned', String(none.v.available));
}

console.log('\n=== 1. the 1.9 world: an unrelated 50 in the window ===');
{
  const r = view(plan(), packet([tx('gift', '2026-09-01', 50)]));
  ok(held(r.rebate), 'the rebate stays listed at 200, To confirm, not received',
    r.rebate && `${r.rebate.status}/${r.rebate.planned}/${r.rebate.toConfirm}`);
  ok(r.receipts.length === 1 && r.receipts[0].actual === 50, 'the gift counts once as its own row');
  ok(r.v.available === PAYROLL + 50, 'Payday balance excludes the 200 while the gift sits in the window',
    String(r.v.available));
  ok(r.v.otherIncome && r.v.otherIncome.amount === 50, 'Other Income total is the gift only',
    JSON.stringify(r.v.otherIncome && r.v.otherIncome.amount));
}

console.log('\n=== 2. near-miss amount: expected 200, receipt 190, same date ===');
{
  const r = view(plan(), packet([tx('r', DATE, 190)]));
  ok(held(r.rebate), 'the 190 does not settle the 200');
  ok(r.v.available === PAYROLL + 190, 'never double counted: Payday balance is payroll + 190',
    String(r.v.available));
}

console.log('\n=== 3. two exact candidates fall to rule 3 ===');
{
  const r = view(plan(), packet([tx('a', DATE, 200), tx('b', DATE, 200)]));
  ok(held(r.rebate), 'neither exact candidate settles the rebate');
  ok(r.receipts.length === 2 && r.v.available === PAYROLL + 400,
    'each receipt counts once and the rebate is not added', String(r.v.available));
}

console.log('\n=== 4. a pending exact match does not settle ===');
{
  const r = view(plan(), packet([tx('p', DATE, 200, { pending: true })]));
  ok(held(r.rebate), 'the pending 200 does not settle the rebate');
  ok(r.v.available === PAYROLL + REBATE, 'the 200 is counted once, from the pending receipt',
    String(r.v.available));
}

console.log('\n=== 5. one posted exact unlinked match settles, as on main ===');
{
  const r = view(plan(), packet([tx('x', DATE, 200)]));
  ok(r.rebate && r.rebate.status === 'received' && r.rebate.actual === 200 && r.receipts.length === 0,
    'the exact receipt settles the rebate and is not a second row');
  ok(r.v.available === PAYROLL + REBATE, 'counted once', String(r.v.available));
}

console.log('\n=== 6. an identity-rule link wins ===');
{
  const full = view(plan(), packet([tx('r', DATE, 200)], [link('r', 200)]));
  ok(full.rebate && full.rebate.status === 'received' && full.rebate.actual === 200
      && full.rebate.reconciledFrom === 'identity-qualified-receipt' && full.v.available === PAYROLL + REBATE,
    'a linked 200 settles the rebate once', String(full.v.available));
  const part = view(plan(), packet([tx('r', DATE, 120)], [link('r', 120)]));
  ok(part.rebate && part.rebate.status === 'received' && part.rebate.actual === 120 && part.rebate.planned === 200
      && part.receipts.length === 0 && part.v.available === PAYROLL + 120,
    'a linked partial 120 settles at its observed actual (existing rule)', String(part.v.available));
  const other = view(plan(), packet([tx('r', '2026-09-01', 190)], [link('r', 190)]));
  ok(other.rebate && other.rebate.status === 'received' && other.rebate.actual === 190,
    'a link settles even when the amount and date differ');
}

console.log('\n=== 7. invariant: never both the expectation and an unlinked receipt ===');
for (const [label, txs] of [
  ['gift 50', [tx('g', '2026-09-01', 50)]], ['near 190', [tx('g', DATE, 190)]],
  ['near 210', [tx('g', DATE, 210)]], ['other date 200', [tx('g', '2026-09-02', 200)]],
  ['two exact', [tx('a', DATE, 200), tx('b', DATE, 200)]], ['pending exact', [tx('p', DATE, 200, { pending: true })]],
]) {
  const r = view(plan(), packet(txs));
  const receiptSum = txs.reduce((s, t) => s - t.amount, 0);
  ok(r.v.available === PAYROLL + receiptSum, `${label}: Payday balance is payroll + receipts, no expectation`,
    `${r.v.available} vs ${PAYROLL + receiptSum}`);
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
