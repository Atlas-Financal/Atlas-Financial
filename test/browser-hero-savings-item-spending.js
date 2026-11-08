'use strict';
// Real Budget page (acceptance harness, production observation path) with an
// invented linked trip purchase: the hero and the Period figures sheet print
// savings-item spending as its own term, and the printed terms add up.
//   payroll 1,400 - bills 0 - household 400 - trip purchase 100 = 900
//   control (no purchase): 1,400 - 0 - 400 = 1,000, no item term
// NODE_PATH=<playwright> node test/browser-hero-savings-item-spending.js
const assert = require('node:assert/strict');
const H = require('./acceptance/harness');

function world(purchase) {
  const w = H.baseWorld();
  w.commitments = [{ id: 'trip', label: 'Invented trip', date: '2026-12-01', amount: 500, confidence: 'confirmed', sinkingFund: true }];
  w.savingsPool = {};
  w.links = [{ categoryId: 106, goalRef: { kind: 'commitment', id: 'trip' }, occurrenceDate: '2026-12-01',
    effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' }];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  if (purchase) w.transactions.push(H.lm({ date: '2026-10-11', amount: 100, category: 'Trip', payee: 'Invented airline' }));
  return w;
}
const c = t => Math.round(Number(String(t).replace(/[$,]/g, '')) * 100);
(async () => {
  try {
    for (const [purchase, expected] of [
      [true, { periodIncome: '$1,400.00', assignedBills: '$0.00', householdBudgetHold: '$400.00', savingsItemSpending: '$100.00', balanceAfterDeductions: '$900.00' }],
      [false, { periodIncome: '$1,400.00', assignedBills: '$0.00', householdBudgetHold: '$400.00', balanceAfterDeductions: '$1,000.00' }],
    ]) {
      for (const width of [1440, 390]) {
        await H.withBudget(world(purchase), async p => {
          const seen = await p.page.evaluate(() => ({
            faces: Object.fromEntries([...document.querySelectorAll('[data-blend-term]')]
              .map(e => [e.getAttribute('data-blend-term'), e.textContent.trim()])),
            sheet: [...document.querySelectorAll('[data-bad-terms]')].map(e => e.textContent.replace(/\s+/g, ' ').trim()).join(' | '),
            minus: [...document.querySelectorAll('[data-operating-question="item"]')]
              .some(e => e.previousElementSibling?.classList.contains('blend-minus')),
          }));
          const tag = `${purchase ? 'purchase' : 'control'} @${width}`;
          assert.deepEqual(seen.faces, expected, `hero faces ${tag}`);
          const f = seen.faces;
          assert.equal(c(f.periodIncome) - c(f.assignedBills) - c(f.householdBudgetHold) - c(f.savingsItemSpending || 0),
            c(f.balanceAfterDeductions), `hero terms add up ${tag}`);
          if (purchase) {
            assert.match(seen.sheet, /Savings item spending \(linked purchases paid from chequing\)\$100\.00 Balance After Deductions\$900\.00/, `sheet ${tag}`);
            assert.equal(seen.minus, true, `the item term has its minus sign ${tag}`);
          } else {
            assert.doesNotMatch(seen.sheet, /Savings item spending/, `control sheet ${tag}`);
          }
        }, { width });
      }
    }
    console.log('ok - the Budget hero and sheet print savings-item spending and the terms add up');
  } finally { await H.closeBrowser(); }
})().catch(e => { console.error(e); process.exit(1); });
