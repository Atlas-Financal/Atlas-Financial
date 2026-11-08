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
      for (const width of [1440, 820, 600, 390]) {
        await H.withBudget(world(purchase), async p => {
          const seen = await p.page.evaluate(() => ({
            faces: Object.fromEntries([...document.querySelectorAll('[data-blend-term]')]
              .map(e => [e.getAttribute('data-blend-term'), e.textContent.trim()])),
            sheet: [...document.querySelectorAll('[data-bad-terms]')].map(e => e.textContent.replace(/\s+/g, ' ').trim()).join(' | '),
            // What is drawn, not only what is in the DOM: the item face must sit
            // with the other terms, above the result, with a visible minus, and
            // its amount must be visible exactly once in the hero.
            geo: (() => {
              const hero = document.querySelector('.blend-hero');
              const box = el => { if (!el) return null; const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
                return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'
                  ? { x: r.left, y: r.top, r: r.right, b: r.bottom } : null; };
              const face = n => box(hero.querySelector('[data-blend-term="' + n + '"]'));
              const minus = box(hero.querySelector('[data-operating-question="item"]')?.previousElementSibling);
              const walker = document.createTreeWalker(hero, NodeFilter.SHOW_TEXT);
              let shown = 0;
              for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                if (n.textContent.trim() !== '$100.00') continue;
                const r = document.createRange(); r.selectNodeContents(n); const b = r.getBoundingClientRect();
                // Hit-test the text's centre: only text actually painted on top counts.
                const hit = b.width > 1 && b.height > 1 && document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
                if (hit && (hit === n.parentElement || n.parentElement.contains(hit))) shown++;
              }
              const glyph = hero.querySelector('[data-operating-question="item"] .operating-number');
              return { item: face('savingsItemSpending'), house: face('householdBudgetHold'), income: face('periodIncome'),
                bad: face('balanceAfterDeductions'), minus, shown, glyphShown: !!box(glyph),
                heroBox: box(hero) };
            })(),
          }));
          const tag = `${purchase ? 'purchase' : 'control'} @${width}`;
          assert.deepEqual(seen.faces, expected, `hero faces ${tag}`);
          const f = seen.faces;
          assert.equal(c(f.periodIncome) - c(f.assignedBills) - c(f.householdBudgetHold) - c(f.savingsItemSpending || 0),
            c(f.balanceAfterDeductions), `hero terms add up ${tag}`);
          if (purchase) {
            assert.match(seen.sheet, /Savings item spending \(linked purchases not paid from Savings\)\$100\.00 Balance After Deductions\$900\.00/, `sheet ${tag}`);
            const g = seen.geo;
            assert.ok(g.item && g.house && g.bad && g.minus, `item face, household face, result and minus are drawn ${tag}`);
            assert.equal(g.shown, 1, `the 100 is visible exactly once in the hero ${tag}`);
            assert.equal(g.glyphShown, false, `no stray = glyph on the item step ${tag}`);
            assert.ok(g.item.b <= g.bad.y, `the item term sits above the result ${tag}`);
            assert.ok(g.item.y >= g.income.y - 1, `the item term is in the equation, not above it ${tag}`);
            assert.ok(g.item.x >= g.heroBox.x - 1 && g.item.r <= g.heroBox.r + 1, `the item face fits inside the hero ${tag}`);
            assert.ok(g.minus.r <= g.item.x + 1 && Math.abs((g.minus.y + g.minus.b) / 2 - (g.item.y + g.item.b) / 2) < 30,
              `the minus is drawn just before the item term ${tag}`);
            assert.ok(g.item.y > g.house.y - 1, `the item term follows household ${tag}`);
          } else {
            assert.doesNotMatch(seen.sheet, /Savings item spending/, `control sheet ${tag}`);
          }
        }, { width });
      }
    }
    console.log('ok - the Budget hero and sheet print savings-item spending and the terms add up');
  } finally { await H.closeBrowser(); }
})().catch(e => { console.error(e); process.exit(1); });
