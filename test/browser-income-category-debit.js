'use strict';
// Budget audit (income sign): money leaving an account in an income category
// is never income received. Only a credit is an inflow. Real page, invented
// household from test/acceptance/harness.js; no household figure enters this
// file. Expected figures are written by hand from the invented inputs.
//
//   node test/browser-income-category-debit.js
//
// Invented baseline: salary 1,400 received Oct 9; plan Groceries 300 +
// Eating out 100, so Balance After Deductions (BAD) is 1,000.
//
// Cases:
//   1. a 50 debit out of chequing in income category "Payroll" is not
//      income: Income stays 1,400, the 50 shows as Other spending needing a
//      category, and BAD is 1,000 - 50 = 950 (never 1,050);
//   2. a reversed paycheque (a 1,400 debit in "Payroll") is not a second
//      income: Income stays 1,400 (never 2,800) and BAD is 1,000 - 1,400 =
//      -400 (never 2,400);
//   3. an income-category debit that pays a represented 37 bill is counted
//      once, as the bill: BAD 1,200 - 150 - 50 - 37 = 963 (Atlas review);
//   4. positive control: a genuine 50 credit in "Payroll" from another payer
//      is still Other income received, and BAD is 1,050.
const H = require('./acceptance/harness.js');

function world() {
  const w = H.baseWorld();
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  return w;
}
// The Balance After Deductions step's own figure: "Balance After Deductions
// $N$N" (heading, then the figure the step closes on).
function bad(s) {
  const m = s.all.match(/Balance After Deductions\s*(?:0\s*)?([−-]?\$[\d,]+\.\d\d)/);
  return m ? m[1].replace('−', '-') : '';
}
function paydayBalance(s) {
  const m = s.income.match(/Payday balance\s*([−-]?\$[\d,]+\.\d\d)/);
  return m ? m[1] : '';
}
function otherSpending(s) { return H.category(s, 'Other spending'); }

const cases = [
  ['a debit in an income category is spending, not income', async () => {
    const w = world();
    w.transactions.push(H.lm({ date: '2026-10-12', amount: 50, category: 'Payroll', account: 'chequing-a', payee: 'Invented clawback' }));
    await H.withBudget(w, async p => {
      const s = await H.snap(p);
      H.expectMatch(s.income, /^\W*Income/, 'positive control: the Income step is rendered');
      H.expect(paydayBalance(s) === '$1,400.00', `payday balance stays 1,400 (got ${paydayBalance(s) || 'nothing'})`);
      H.expectNoMatch(s.income, /Other income\s*\$50\.00/, 'the debit is not other income');
      H.expectNoMatch(s.income, /Received\s*\$50\.00/, 'the debit is not received income');
      H.expectMatch(otherSpending(s), /Other spending\$50\.00/, 'the debit is Other spending of 50');
      H.expect(bad(s) === '$950.00', `BAD is 1,000 - 50 = 950 (got ${bad(s) || 'nothing'})`);
    });
  }],
  ['a reversed paycheque is not a second income', async () => {
    const w = world();
    w.transactions.push(H.lm({ date: '2026-10-13', amount: 1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer reversal' }));
    await H.withBudget(w, async p => {
      const s = await H.snap(p);
      H.expectMatch(s.income, /^\W*Income/, 'positive control: the Income step is rendered');
      H.expect(paydayBalance(s) === '$1,400.00', `payday balance stays 1,400, never 2,800 (got ${paydayBalance(s) || 'nothing'})`);
      H.expectExcludes(s.income, '$2,800.00', 'income is never doubled');
      H.expectMatch(otherSpending(s), /Other spending\$1,400\.00/, 'the reversal is Other spending of 1,400');
      H.expect(bad(s) === '-$400.00', `BAD is 1,000 - 1,400 = -400 (got ${bad(s) || 'nothing'})`);
    });
  }],
  ['an income-category debit that pays a represented bill is counted once, as the bill', async () => {
    // Atlas review of #916: salary 1,200; Groceries 150 + Restaurants 50; a
    // confirmed 37 internet bill due Oct 12 paid by a 37 debit from its payee
    // on the Bills account. One payment: 1,200 - 150 - 50 - 37 = 963, whether
    // the debit is categorised Internet or (income-flagged) Payroll. It is
    // never also Other spending.
    for (const category of ['Internet', 'Payroll']) {
      const w = H.baseWorld();
      w.income[0].amount = 1200; w.budget[0].plannedPayday = 150; w.budget[1].plannedPayday = 50;
      w.bills = [{ id: 'invented-net', label: 'Invented internet', amount: 37, frequency: 'monthly', day: 12,
        confidence: 'confirmed', payee: 'Invented ISP' }];
      w.transactions = [H.lm({ date: '2026-10-09', amount: -1200, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
        H.lm({ date: '2026-10-12', amount: 37, category, account: 'chequing-a', payee: 'Invented ISP' })];
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(H.bill(s, 'Invented internet'), /\$37\.00\s*Paid/, `${category}: the bill is Paid at 37`);
        H.expect(!s.categories.some(row => row.startsWith('Other spending')), `${category}: the payment is not also Other spending`);
        H.expect(bad(s) === '$963.00', `${category}: BAD is 1,200 - 150 - 50 - 37 = 963 (got ${bad(s) || 'nothing'})`);
      });
    }
  }],
  ['positive control: a credit in an income category is still other income', async () => {
    const w = world();
    w.transactions.push(H.lm({ date: '2026-10-12', amount: -50, category: 'Payroll', account: 'chequing-a', payee: 'Invented side payer' }));
    await H.withBudget(w, async p => {
      const s = await H.snap(p);
      H.expectMatch(s.income, /Other income\s*\$50\.00/, 'the credit is other income of 50');
      H.expect(paydayBalance(s) === '$1,450.00', `payday balance is 1,400 + 50 (got ${paydayBalance(s) || 'nothing'})`);
      H.expect(bad(s) === '$1,050.00', `BAD is 1,000 + 50 = 1,050 (got ${bad(s) || 'nothing'})`);
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
