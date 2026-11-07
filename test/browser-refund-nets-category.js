'use strict';
// G3a (acceptance 7.8 and 5.6): an identified refund nets against the
// household category it reverses, through the Budget page a household reads.
// Real page, invented household from test/acceptance/harness.js; no
// household figure enters this file.
//
//   node test/browser-refund-nets-category.js
//
// Cases:
//   1. a refund within the period nets (40 - 10 = 30);
//   2. a refund larger than the period's spend nets signed below zero (spec
//      5.6; lead ruling, no floor), and the household total is the signed sum
//      of the category rows; never income or Other;
//   3. an unidentified inbound credit does not net and is not income
//      (no category; and a credit in a category with no budget row);
//   4. a refund posted after a period closes leaves the closed period
//      unchanged and nets in the open period only.
const H = require('./acceptance/harness.js');

function world() {
  const w = H.baseWorld();
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  return w;
}
const groceries = s => H.category(s, 'Groceries');
function notIncomeOrOther(s, payee, why) {
  H.expectMatch(s.income, /^\W*Income/, 'positive control: the Income step is rendered');
  H.expectExcludes(s.income, payee, why + ': not income');
  H.expect(!/Other spending/.test(s.categories.join(' | ')), why + ': not Other');
}

const cases = [
  ['a refund within the period nets against its category', async () => {
    const w = world();
    w.transactions.push(
      H.lm({ date: '2026-10-10', amount: 40, category: 'Groceries', payee: 'Invented grocer A' }),
      H.lm({ date: '2026-10-12', amount: -10, category: 'Groceries', payee: 'Invented grocer A' }));
    await H.withBudget(w, async p => {
      const s = await H.snap(p);
      H.expectMatch(groceries(s), /Spent \$30\.00/, 'groceries spent is 40 - 10');
      H.expectMatch(groceries(s), /\$270\.00 left/, 'remaining is 300 - 30');
      H.expectMatch(s.household, /Household Budget TotalActual \/ Planned \$30\.00/, 'the total agrees with the rows: 30 + 0');
      notIncomeOrOther(s, 'Invented grocer A', 'the refund');
    });
  }],
  ['a refund larger than the period spend nets signed, below zero', async () => {
    // Lead ruling (spec 5.6 wins): no floor. The money came back, so the
    // category shows negative spent, and the household total agrees.
    const w = world();
    w.transactions.push(
      H.lm({ date: '2026-10-10', amount: 15, category: 'Groceries', payee: 'Invented grocer B' }),
      H.lm({ date: '2026-10-11', amount: 5, category: 'Restaurants', payee: 'Invented diner B' }),
      H.lm({ date: '2026-10-12', amount: -25, category: 'Groceries', payee: 'Invented grocer B' }));
    await H.withBudget(w, async p => {
      const s = await H.snap(p);
      H.expectMatch(groceries(s), /Spent [−-]\$10\.00/, 'groceries spent is 15 - 25');
      H.expectMatch(H.category(s, 'Eating out'), /Spent \$5\.00/, 'eating out is unchanged');
      H.expectMatch(s.household, /Household Budget TotalActual \/ Planned [−-]\$5\.00/, 'the total is the signed sum of the rows: -10 + 5');
      notIncomeOrOther(s, 'Invented grocer B', 'the refund');
    });
  }],
  ['an unidentified inbound credit does not net and is not income', async () => {
    const w = world();
    w.transactions.push(
      H.lm({ date: '2026-10-10', amount: 40, category: 'Groceries', payee: 'Invented grocer C' }),
      H.lm({ date: '2026-10-11', amount: -10, payee: 'Invented unknown credit' }),
      H.lm({ date: '2026-10-12', amount: -10, category: 'Gifts', payee: 'Invented gift credit' }));
    await H.withBudget(w, async p => {
      const s = await H.snap(p);
      H.expectMatch(groceries(s), /Spent \$40\.00/, 'groceries spent is unchanged at 40');
      H.expectMatch(s.income, /^\W*Income/, 'positive control: the Income step is rendered');
      H.expectExcludes(s.income, 'Invented unknown credit', 'an uncategorised credit is not income');
      H.expectExcludes(s.income, 'Invented gift credit', 'a credit outside any budget category is not income');
    });
  }],
  ['a refund after the close leaves the closed period unchanged', async () => {
    const w = world();
    w.transactions = [
      H.lm({ date: '2026-09-25', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
      H.lm({ date: '2026-10-03', amount: 70, category: 'Groceries', payee: 'Invented grocer D' }),
      H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
      H.lm({ date: '2026-10-10', amount: 30, category: 'Groceries', payee: 'Invented grocer E' }),
      H.lm({ date: '2026-10-12', amount: -20, category: 'Groceries', payee: 'Invented grocer D' }),
    ];
    await H.withBudget(w, async p => {
      const now = await H.snap(p);
      H.expectMatch(groceries(now), /Spent \$10\.00/, 'the refund nets in the open period: 30 - 20');
      await p.step(-1);
      const s = await H.snap(p);
      H.expectMatch(s.range, /Sep 25/, 'stepped back to the closed Sep 25 - Oct 8 period');
      H.expectMatch(groceries(s), /Spent \$70\.00/, 'the closed period keeps 70');
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
