'use strict';
// A pending row that only looks like a posted one (same date, account,
// amount and merchant) may be a second real purchase. Through the Budget
// page a household reads, it stays visible with a possible-duplicate mark,
// and its category's spent and the household actual are marked estimated
// until it resolves, never a precise calculated total. The plan keeps its
// own trust, and Balance After Deductions is unchanged. Real page, invented
// household from test/acceptance/harness.js (income 1,400; Groceries 300 +
// Eating out 100); no household figure enters this file.
//
//   node test/browser-pending-lookalike.js
//
// Expectations are hand-derived from the rule, not read from the code:
//   1. two 6.50 cafe purchases on Oct 11, one posted and one pending: both
//      rows are listed, the pending one says "Possible duplicate"; Eating out
//      shows Spent ≈ estimated 6.50 and ≈ estimated 93.50 left, of planned
//      100 with no estimate mark on the plan; the household total is
//      ≈ estimated 6.50 of planned 400; Groceries is untouched (300 left);
//      Balance After Deductions stays 1,400 - 400 = 1,000.
//   2. the same look-alike in an unassigned (Uncategorised) purchase: the
//      Other spending row reads ≈ estimated 6.50, not a precise 6.50.
//   3. control: one pending 6.50 with no posted look-alike is counted as
//      before (Spent 6.50, 93.50 left), unmarked.
//   4. control: a pending row joined to its posted successor by the provider
//      (directed pending id) counts once (Spent 30) with no mark.
//   5. control (#852): one provider id delivered twice as posted still makes
//      the category Unknown.
// Since #881 was first built, main prints an "Incomplete" Spent marker in
// this invented world (spentIncomplete, unrelated to look-alikes). The
// control expectations pin today's exact text, marker included.
const H = require('./acceptance/harness.js');

function world() {
  const w = H.baseWorld();
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  return w;
}
const eatingOut = s => H.category(s, 'Eating out');

const cases = [
  ['a pending look-alike stays visible, marked, and the totals are estimated', async () => {
    const w = world();
    w.transactions.push(
      H.lm({ date: '2026-10-11', amount: 6.5, category: 'Restaurants', payee: 'Invented cafe' }),
      H.lm({ date: '2026-10-11', amount: 6.5, category: 'Restaurants', payee: 'Invented cafe', pending: true }));
    await H.withBudget(w, async p => {
      const s = await H.snap(p);
      H.expectMatch(eatingOut(s), /Spent ≈\s*estimated \$6\.50/, 'Eating out spent is marked estimated');
      H.expectMatch(eatingOut(s), /≈\s*estimated \$93\.50 left/, 'Eating out remaining is marked estimated');
      H.expectMatch(eatingOut(s), /of planned \$100\.00/, 'the plan keeps its own trust: no estimate mark on planned');
      H.expectMatch(s.household, /Household budget ≈\s*estimated \$6\.50 \/ of planned \$400\.00/, 'the household actual is estimated, never a precise 6.50');
      H.expectMatch(s.household, /Household Budget TotalActual \/ Planned ≈\s*estimated \$6\.50/, 'the total line is estimated too');
      H.expect(H.occurrences(s.household, 'Invented cafe') === 2, `both cafe rows are listed (got ${H.occurrences(s.household, 'Invented cafe')})`);
      H.expect(H.occurrences(s.household, 'Possible duplicate') === 1, 'exactly the pending row carries the possible-duplicate mark');
      H.expectMatch(s.household, /Invented cafe\s*Pending\s*Possible duplicate/, 'the mark is on the pending row');
      H.expectMatch(H.category(s, 'Groceries'), /^Groceries\$300\.00 left Incomplete Spent \$0\.00 Incomplete \/ of planned \$300\.00/, 'an unrelated category is untouched');
      H.expectMatch(s.all, /Balance After Deductions\$1,000\.00/, 'Balance After Deductions stays 1,400 - 400');
    });
  }],
  ['a pending look-alike in unassigned spending marks Other estimated', async () => {
    const w = world();
    w.transactions.push(
      H.lm({ date: '2026-10-11', amount: 6.5, category: 'Uncategorised', payee: 'Invented kiosk' }),
      H.lm({ date: '2026-10-11', amount: 6.5, category: 'Uncategorised', payee: 'Invented kiosk', pending: true }));
    await H.withBudget(w, async p => {
      const s = await H.snap(p);
      const other = H.category(s, 'Other spending');
      H.expectMatch(other, /^Other spending≈\s*estimated \$6\.50/, 'Other spent is marked estimated, not a precise 6.50');
      H.expectMatch(s.household, /Invented kiosk\s*Pending\s*Possible duplicate/, 'the pending kiosk row stays listed and marked');
      H.expectNoMatch(s.household, /Household Budget TotalActual \/ Planned \$6\.50/, 'no precise household total');
    });
  }],
  ['control: a lone pending purchase counts as before, unmarked', async () => {
    const w = world();
    w.transactions.push(H.lm({ date: '2026-10-11', amount: 6.5, category: 'Restaurants', payee: 'Invented cafe', pending: true }));
    await H.withBudget(w, async p => {
      const s = await H.snap(p);
      H.expectMatch(eatingOut(s), /Spent \$6\.50/, 'a lone pending purchase is counted');
      H.expectMatch(eatingOut(s), /^Eating out\$93\.50 left Incomplete Spent \$6\.50 Incomplete \/ of planned \$100\.00/, 'remaining is 100 - 6.50, unmarked');
      H.expectExcludes(s.household, 'Possible duplicate', 'no possible-duplicate mark on a lone pending');
    });
  }],
  ['control: a directed pending-to-posted pair counts once, unmarked', async () => {
    const w = world();
    w.transactions.push(
      H.lm({ id: 700, date: '2026-10-11', amount: 30, category: 'Groceries', payee: 'Invented bakery', pending: true }),
      H.lm({ id: 701, date: '2026-10-12', amount: 30, category: 'Groceries', payee: 'Invented bakery',
        raw: { pending_transaction_id: 700, plaid_metadata: { pending_transaction_id: 'invented-plaid-700' } } }));
    w.transactions[1].plaid_metadata = { transaction_id: 'invented-plaid-700' };
    await H.withBudget(w, async p => {
      const s = await H.snap(p);
      H.expectMatch(H.category(s, 'Groceries'), /Spent \$30\.00/, 'groceries spent is 30, not 60');
      H.expectExcludes(s.household, 'Possible duplicate', 'no possible-duplicate mark on a resolved pair');
    });
  }],
  ['control (#852): one provider id delivered twice as posted keeps the category Unknown', async () => {
    const w = world();
    w.transactions.push(
      H.lm({ id: 900, date: '2026-10-11', amount: 12, category: 'Restaurants', payee: 'Invented diner' }),
      H.lm({ id: 900, date: '2026-10-11', amount: 12, category: 'Restaurants', payee: 'Invented diner' }));
    await H.withBudget(w, async p => {
      const s = await H.snap(p);
      H.expect(eatingOut(s), 'positive control: the Eating out row is listed');
      H.expectMatch(eatingOut(s), /Unknown|Unavailable/, 'Eating out is Unknown');
      H.expectNoMatch(eatingOut(s), /\$(88|76)\.00 left/, 'no precise remaining');
    });
  }],
];

(async () => {
  let failures = 0;
  for (const [name, run] of cases) {
    try { await run(); console.log('  PASS  ' + name); }
    catch (err) { failures++; console.log('  FAIL  ' + name + ' -- ' + String(err && err.message || err).split('\n')[0]); }
  }
  if (H.closeBrowser) await H.closeBrowser();
  console.log(failures ? `\n${failures} failure(s)` : '\nall cases pass');
  process.exit(failures ? 1 : 0);
})();
