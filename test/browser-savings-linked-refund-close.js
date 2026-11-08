'use strict';
// Savings audit PR 2, through the Budget page a household reads. Real page,
// invented household from test/acceptance/harness.js; no household figure
// enters this file.
//
//   node test/browser-savings-linked-refund-close.js
//
// Given payroll 1,400, a plan of Groceries 300 + Eating out 100 and a 500
// trip linked to category Trip. When a linked 100 chequing purchase (Oct 10)
// is followed by a linked 30 refund (Oct 12), Then, by hand:
//   - the trip shows Paid 70 and needs 430;
//   - Balance After Deductions = 1,400 - 0 - 400 - 70 = 930 (the bug: 900).
const H = require('./acceptance/harness.js');

function world(txs) {
  const w = H.baseWorld();
  w.savingsPool = {};
  w.commitments = [{ id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: 500, confidence: 'confirmed', sinkingFund: true }];
  w.links = [{ categoryId: 106, goalRef: { kind: 'commitment', id: 'trip' }, occurrenceDate: '2026-11-20', effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' }];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    ...txs.map(t => H.lm({ category: 'Trip', payee: 'Invented airline', ...t }))];
  return w;
}
const bad = s => (s.all.match(/Balance After Deductions\s*(\$[\d,]+\.\d\d)/) || [])[1] || '';

(async () => {
  let failed = 0;
  const run = async (name, fn) => {
    try { await fn(); console.log('ok   ' + name); } catch (e) { failed += 1; console.log('FAIL ' + name + ': ' + e.message); }
  };
  await run('a linked charge alone: Balance After Deductions 1,400 - 400 - 100 = 900', () => H.withBudget(world([{ date: '2026-10-10', amount: 100 }]), async p => {
    const s = await H.snap(p);
    H.expect(bad(s) === '$900.00', `got ${bad(s)}`);
  }));
  await run('a linked refund is credited: Balance After Deductions 930, trip Paid 70', () => H.withBudget(world([{ date: '2026-10-10', amount: 100 }, { date: '2026-10-12', amount: -30 }]), async p => {
    const s = await H.snap(p);
    H.expectFigure(H.goal(s, 'Invented trip'), 'Paid', '$70.00', 'the item nets the refund');
    H.expectMatch(H.goal(s, 'Invented trip'), /\$430\.00\s*Needed/, 'the item needs 430');
    H.expect(bad(s) === '$930.00', `Balance After Deductions credits the 30 refund (got ${bad(s)})`);
  }));
  await H.closeBrowser();
  if (failed) { console.log(`${failed} case(s) failed`); process.exit(1); }
  console.log('Linked refund through the Budget page: credited once.');
})();
