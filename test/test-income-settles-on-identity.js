'use strict';
/* C3 (acceptance 1.9): an expected one-off income is settled only by a
 * receipt with qualified identity evidence for that income.
 *
 * Qualified identity evidence is provider-observe's identity-rule link
 * (source payee, Atlas account, posting-date window) carried on the
 * current-period packet's representedActuals with its transactionId.
 * Amount, date or pay-period window alone never settles an expectation.
 *
 * Invented figures only. Expectations are hand-derived from the fixture:
 * an expected rebate of 200 on Sep 3 inside the active Aug 28 - Sep 10
 * window, observed as of Sep 9.
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
const REBATE_DATE = '2026-09-03';
const plan = () => ({
  defaults: { targetBuffer: 0 },
  startingCash: { breakdown: [{ id: 'chequing-a', label: 'Invented bills account', value: 2000, class: 'spendable' }] },
  opening: { asOf: AS_OF, representedEvents: [] },
  income: [
    { id: 'payroll', frequency: 'biweekly', anchor: '2026-08-14', amount: 1000, confidence: 'confirmed' },
    { id: 'rebate', label: 'Invented rebate', frequency: 'once', date: REBATE_DATE, amount: 200,
      incomeClass: 'other', confidence: 'confirmed' },
  ],
  bills: [], obligations: [], commitments: [], budget: { categories: [] },
});
const tx = (id, date, amount, payee) => ({ id, date, amount: -amount, isIncome: true,
  categoryLabel: 'other income', displayedPayee: payee, accountRole: 'household-cash' });
const packet = (transactions, representedActuals = []) => ({
  schema: 'atlas-current-period-actuals/v1', observationAsOf: AS_OF,
  coverageStart: '2026-07-31', coverageThrough: AS_OF, transactionCoverage: 'complete', pendingCoverage: 'complete',
  representedActuals, transactions,
});
const link = (txId, amount, date = REBATE_DATE) =>
  ({ id: 'rebate', date, actual: -amount, postedOn: date, transactionId: txId });
const activeIncome = pkt => {
  const advice = F.recommend(plan(), AS_OF, { targetBuffer: 0, debts: [], currentPeriodActuals: pkt });
  const period = (advice.payPeriodViews || []).find(p => p.start <= REBATE_DATE && p.end >= REBATE_DATE);
  return (period && period.income) || [];
};
const rebateOf = rows => rows.find(r => r && r.id === 'rebate') || null;
const otherRows = rows => rows.filter(r => r && String(r.id).startsWith('other-income:'));

console.log('\n=== 1. an unrelated receipt does not settle the expected rebate ===');
for (const [label, receipt] of [
  ['an unrelated 50 in the same window', tx('tx-gift', '2026-09-01', 50, 'Invented gift')],
  ['an unrelated 200 on the same date', tx('tx-gift', REBATE_DATE, 200, 'Invented gift')],
]) {
  const rows = activeIncome(packet([receipt]));
  const rebate = rebateOf(rows);
  ok(rebate && rebate.status !== 'received' && rebate.actual == null && rebate.reconciledFrom == null,
    `${label}: the rebate stays expected, not received`, rebate && `${rebate.status}/${rebate.actual}`);
  ok(rebate && rebate.planned === 200 && rebate.amount === 200,
    `${label}: the rebate still reads 200`, rebate && `${rebate.planned}/${rebate.amount}`);
  const gift = otherRows(rows);
  ok(gift.length === 1 && gift[0].actual === receipt.amount * -1 && gift[0].planned === 0,
    `${label}: the receipt is its own Other income row, never the rebate`, JSON.stringify(gift.map(r => r.actual)));
}

console.log('\n=== 2. a qualified receipt settles the expected rebate ===');
{
  const rows = activeIncome(packet([tx('tx-rebate', REBATE_DATE, 200, 'Invented rebate co')], [link('tx-rebate', 200)]));
  const rebate = rebateOf(rows);
  ok(rebate && rebate.status === 'received' && rebate.actual === 200
      && rebate.reconciledFrom === 'identity-qualified-receipt',
    'the identity-linked receipt settles the rebate at 200', rebate && `${rebate.status}/${rebate.actual}/${rebate.reconciledFrom}`);
  ok(otherRows(rows).length === 0, 'the linked receipt is not also a separate Other income row');
}

console.log('\n=== 3. a partial qualified receipt keeps the represented-actual rule ===');
{
  // Existing rule: a qualified receipt settles its occurrence and the row
  // publishes the observed actual, not the planned amount.
  const rows = activeIncome(packet([tx('tx-rebate', REBATE_DATE, 120, 'Invented rebate co')], [link('tx-rebate', 120)]));
  const rebate = rebateOf(rows);
  ok(rebate && rebate.status === 'received' && rebate.actual === 120 && rebate.planned === 200,
    'the partial receipt settles at its observed 120 against planned 200',
    rebate && `${rebate.status}/${rebate.actual}/${rebate.planned}`);
  ok(otherRows(rows).length === 0, 'the partial receipt is not double counted');
}

console.log('\n=== 4. a link that does not resolve to exactly one receipt does not settle ===');
{
  const missing = rebateOf(activeIncome(packet([tx('tx-gift', REBATE_DATE, 200, 'Invented gift')], [link('tx-absent', 200)])));
  ok(missing && missing.status !== 'received' && missing.actual == null,
    'a link to an absent transaction leaves the rebate expected');
  const twice = rebateOf(activeIncome(packet(
    [tx('tx-a', REBATE_DATE, 100, 'Invented rebate co'), tx('tx-b', REBATE_DATE, 100, 'Invented rebate co')],
    [link('tx-a', 100), link('tx-b', 100)])));
  ok(twice && twice.status !== 'received' && twice.actual == null,
    'two links for one occurrence are ambiguous and leave the rebate expected');
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
