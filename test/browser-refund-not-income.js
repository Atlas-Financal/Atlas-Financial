'use strict';
// Budget audit (refunds as income): a refund or card credit is never income
// received. Other income needs a household cash account and a Lunch Money
// income category (or the automatic external cash-deposit identity);
// category wording such as Gifts, Rebate or Reimbursement never makes a
// refund income, and a debit under a refund label is spending, not an
// invisible refund. Real page, invented household from
// test/acceptance/harness.js; no household figure enters this file.
// Expected figures are written by hand from the invented inputs.
//
//   node test/browser-refund-not-income.js
//
// Invented baseline: salary 1,400 received Oct 9; plan Groceries 300 +
// Eating out 100, so Balance After Deductions (BAD) is 1,000.
//
// Cases (G3a stands: a refund of a named budget category nets against that
// category; any other refund stays excluded, never income, never Other):
//   a. a 100 "Reimbursement" debit then a 100 credit on chequing: the debit
//      is Other spending 100, the credit is not income, BAD 1,000 - 100 = 900
//      (never 1,100);
//   b. a 60 "Gifts" card purchase in the previous period refunded to the
//      card in this one: not income, BAD 1,000 (never 1,060);
//   c. a 25 "Rebate" card credit: not income, BAD 1,000 (never 1,025);
//   d. a same-period 60 "Gifts" purchase and return on chequing: income
//      stays 1,400 (never 1,460); the purchase stays in Other and the return
//      is excluded, BAD 1,000 - 60 = 940;
//   e. positive control: a 50 credit on chequing in a Lunch Money income
//      category is still Other income received, BAD 1,050;
//   f. positive control (G3a): a 10 Groceries card refund still nets
//      against Groceries (40 - 10 = 30) and is not income;
//   g. an owner-expected 175 one-off that arrives early as an unflagged
//      credit of exactly 175 is Received, counted once (BAD 1,175).
const H = require('./acceptance/harness.js');

function world() {
  const w = H.baseWorld();
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  return w;
}
function withCard(w) {
  w.accounts.push({ id: 'travelvisa', providerId: 9004, role: 'revolving-credit', collection: 'debts', label: 'Invented card', value: 0 });
  w.debts = [{ id: 'travelvisa', label: 'Invented card', structure: 'Revolving', secured: false, balance: 0,
    pending: 0, rate: 0, limit: 2000, statementCloseDay: 17 }];
  return w;
}
const card = f => H.lm(Object.assign({ account: 'travelvisa', providerAccountId: 9004 }, f));
function bad(s) {
  const m = s.all.match(/Balance After Deductions\s*(?:0\s*)?([−-]?\$[\d,]+\.\d\d)/);
  return m ? m[1].replace('−', '-') : '';
}
function paydayBalance(s) {
  const m = s.income.match(/Payday balance\s*([−-]?\$[\d,]+\.\d\d)/);
  return m ? m[1] : '';
}
function notIncome(s, payee, why) {
  H.expectMatch(s.income, /^\W*Income/, 'positive control: the Income step is rendered');
  H.expect(paydayBalance(s) === '$1,400.00', `${why}: payday balance stays 1,400 (got ${paydayBalance(s) || 'nothing'})`);
  H.expectExcludes(s.income, payee, `${why}: not listed as income`);
  H.expectNoMatch(s.income, /Other income\s*\$[1-9]/, `${why}: no other income`);
}
function expectBad(s, amount, why) { H.expect(bad(s) === amount, `${why} (got ${bad(s) || 'nothing'})`); }

const cases = [
  ['a. a Reimbursement debit is spending and its credit is not income', async () => {
    const w = world();
    w.categories.push({ id: 112, name: 'Reimbursement' });
    w.transactions.push(
      H.lm({ date: '2026-10-11', amount: 100, category: 112, account: 'chequing-a', payee: 'Invented outlay' }),
      H.lm({ date: '2026-10-12', amount: -100, category: 112, account: 'chequing-a', payee: 'Invented payback' }));
    await H.withBudget(w, async p => {
      const s = await H.snap(p);
      notIncome(s, 'Invented payback', 'the reimbursement credit');
      H.expectMatch(H.category(s, 'Other spending'), /Other spending\$100\.00/, 'the reimbursement debit is Other spending of 100');
      expectBad(s, '$900.00', 'BAD is 1,000 - 100 = 900');
    });
  }],
  ['b. a previous-period card purchase refunded to the card is not income', async () => {
    const w = withCard(world());
    w.transactions.push(
      card({ date: '2026-10-05', amount: 60, category: 'Gifts', payee: 'Invented gift shop' }),
      card({ date: '2026-10-12', amount: -60, category: 'Gifts', payee: 'Invented gift shop' }));
    await H.withBudget(w, async p => {
      const s = await H.snap(p);
      notIncome(s, 'Invented gift shop', 'the card refund');
      expectBad(s, '$1,000.00', 'BAD stays 1,000');
    });
  }],
  ['c. a Rebate card credit is not income', async () => {
    const w = withCard(world());
    w.categories.push({ id: 113, name: 'Rebate' });
    w.transactions.push(card({ date: '2026-10-12', amount: -25, category: 113, payee: 'Invented rebate' }));
    await H.withBudget(w, async p => {
      const s = await H.snap(p);
      notIncome(s, 'Invented rebate', 'the card rebate');
      expectBad(s, '$1,000.00', 'BAD stays 1,000');
    });
  }],
  ['d. a same-period gift return is not income', async () => {
    const w = world();
    w.transactions.push(
      H.lm({ date: '2026-10-10', amount: 60, category: 'Gifts', payee: 'Invented gift store' }),
      H.lm({ date: '2026-10-12', amount: -60, category: 'Gifts', payee: 'Invented gift store' }));
    await H.withBudget(w, async p => {
      const s = await H.snap(p);
      notIncome(s, 'Invented gift store', 'the gift return');
      H.expectExcludes(s.income, '$1,460.00', 'income is never 1,460');
      H.expectMatch(H.category(s, 'Other spending'), /Other spending\$60\.00/, 'the purchase stays in Other (G3a: Other refunds are excluded)');
      expectBad(s, '$940.00', 'BAD is 1,000 - 60 = 940');
    });
  }],
  ['e. positive control: an income-category credit on chequing is other income', async () => {
    const w = world();
    w.transactions.push(H.lm({ date: '2026-10-12', amount: -50, category: 'Payroll', account: 'chequing-a', payee: 'Invented side payer' }));
    await H.withBudget(w, async p => {
      const s = await H.snap(p);
      H.expectMatch(s.income, /Other income\s*\$50\.00/, 'the credit is other income of 50');
      H.expect(paydayBalance(s) === '$1,450.00', `payday balance is 1,400 + 50 (got ${paydayBalance(s) || 'nothing'})`);
      expectBad(s, '$1,050.00', 'BAD is 1,000 + 50 = 1,050');
    });
  }],
  ['f. positive control: a named-category card refund still nets (G3a)', async () => {
    const w = withCard(world());
    w.transactions.push(
      card({ date: '2026-10-10', amount: 40, category: 'Groceries', payee: 'Invented grocer F' }),
      card({ date: '2026-10-12', amount: -10, category: 'Groceries', payee: 'Invented grocer F' }));
    await H.withBudget(w, async p => {
      const s = await H.snap(p);
      H.expectMatch(H.category(s, 'Groceries'), /Spent \$30\.00/, 'groceries spent is 40 - 10');
      notIncome(s, 'Invented grocer F', 'the groceries refund');
    });
  }],
  ['g. an expected one-off settled early by an unflagged credit of its exact amount is Received', async () => {
    // Owner plans a 175 tax refund for Oct 20; it arrives Oct 12 as an
    // unflagged Reimbursement credit of exactly 175. The row is Received
    // (not still arriving); income counts it once: 1,400 + 175 = 1,575 and
    // BAD 1,000 + 175 = 1,175.
    const w = world();
    w.categories.push({ id: 112, name: 'Reimbursement' });
    w.income.push({ id: 'refund', label: 'Invented tax refund', frequency: 'once', date: '2026-10-20', amount: 175,
      incomeClass: 'other', confidence: 'confirmed' });
    w.accounts.find(a => a.id === 'chequing-a').value = 2175;
    w.transactions.push(H.lm({ date: '2026-10-12', amount: -175, category: 112, account: 'chequing-a', payee: 'Invented tax office' }));
    await H.withBudget(w, async p => {
      const s = await H.snap(p);
      H.expectMatch(s.income, /Invented tax refund\s*Received\s*\$175\.00/, 'the expected refund is Received');
      H.expect(paydayBalance(s) === '$1,575.00', `payday balance is 1,400 + 175 (got ${paydayBalance(s) || 'nothing'})`);
      H.expectExcludes(s.income, 'Invented tax office', 'the credit is not a second income item');
      expectBad(s, '$1,175.00', 'BAD is 1,000 + 175 = 1,175');
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
