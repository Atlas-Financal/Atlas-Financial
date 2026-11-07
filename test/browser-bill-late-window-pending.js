'use strict';
// #918 Systems Review regression, through the Budget page a household reads.
// Under the opt-in 'due-or-up-to-two-days-after' bill window, pending
// evidence is identity only and never inherits: a pending-only debit, or a
// pending debit whose posted replacement is outside due..due+2, a credit or
// zero, never renders Paid. A posted debit inside the window does. Real page, invented household from
// test/acceptance/harness.js; no household figure enters this file.
//
//   node test/browser-bill-late-window-pending.js
const H = require('./acceptance/harness.js');

const WINDOW = { postingDateRule: 'due-or-up-to-two-days-after' };
function world(txs, asOf) {
  const w = H.baseWorld(asOf);
  w.bills = [{ id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12,
    confidence: 'confirmed', payee: 'Invented hydro', rule: { ...WINDOW } }];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a',
    payee: 'Invented employer' })].concat(txs);
  return w;
}
const debit = (date, extra) => H.lm({ date, amount: 90, category: 'Utilities', account: 'chequing-a',
  payee: 'Invented hydro', ...(extra || {}) });

const cases = [
  ['a pending-only debit on +1 does not render Paid', world([debit('2026-10-13', { pending: true })]), false],
  ['a pending +1 replaced by a posted +4 (same id) does not render Paid',
    world([debit('2026-10-13', { pending: true, id: 881001 }), debit('2026-10-16', { id: 881001 })], '2026-10-16'), false],
  ['a pending +1 replaced by a posted +4 (directed Plaid link) does not render Paid',
    world([debit('2026-10-13', { pending: true, id: 881011, raw: { plaid_metadata: { transaction_id: 'plaid-b-pending' } } }),
      debit('2026-10-16', { id: 881012, raw: { plaid_metadata: { transaction_id: 'plaid-b-posted',
        pending_transaction_id: 'plaid-b-pending' } } })], '2026-10-16'), false],
  ['a pending +1 replaced by a posted +2 credit (same id) does not render Paid',
    world([debit('2026-10-13', { pending: true, id: 881101 }), debit('2026-10-14', { id: 881101, amount: -90 })], '2026-10-16'), false],
  ['a pending +1 replaced by a posted +2 zero (directed Plaid link) does not render Paid',
    world([debit('2026-10-13', { pending: true, id: 881111, raw: { plaid_metadata: { transaction_id: 'plaid-z-pending' } } }),
      debit('2026-10-14', { id: 881112, amount: 0, raw: { plaid_metadata: { transaction_id: 'plaid-z-posted',
        pending_transaction_id: 'plaid-z-pending' } } })], '2026-10-16'), false],
  ['a pending +1 replaced by a posted +2 debit renders Paid through its own posted row',
    world([debit('2026-10-13', { pending: true, id: 881121 }), debit('2026-10-14', { id: 881121 })], '2026-10-16'), true],
  ['positive control: a posted +1 debit renders Paid', world([debit('2026-10-13')]), true],
];

(async () => {
  let failures = 0;
  try {
    for (const [name, w, paid] of cases) {
      try {
        await H.withBudget(w, async p => {
          const s = await H.snap(p);
          const row = H.bill(s, 'Invented hydro');
          H.expect(row, 'positive control: the hydro bill is listed');
          if (paid) H.expectMatch(row, /\$90\.00\s*Paid/, 'posted inside the window is Paid');
          else H.expectNoMatch(row, /Paid/, 'not Paid without a posted debit inside the window');
        });
        console.log(`  PASS  ${name}`);
      } catch (e) {
        failures++;
        console.log(`  FAIL  ${name} — ${e.message}`);
      }
    }
  } finally {
    await H.closeBrowser();
  }
  if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
  console.log('\nAll rendered late-window pending checks passed.');
})();
