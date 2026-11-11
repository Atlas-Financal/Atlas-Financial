'use strict';
// Page companion of test/test-savings-owner-confirmed-paid.js (acceptance
// 2.6 / 2.7): the Budget page a household reads, through the real page and
// the invented acceptance harness world. Needs the pre-installed browser, so
// like the other browser-*.js proofs it is not in the CI manifest. Every
// amount is invented; expected text is hand-written.
const assert = require('node:assert/strict');
const H = require('./acceptance/harness');

const TRIP_LINK = { categoryId: 106, goalRef: { kind: 'commitment', id: 'trip' }, occurrenceDate: '2026-11-20',
  effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' };
// A 600 trip (Nov 20, owner-confirmed Oct 12) and a 600 gift (Dec 10).
function world(savings, purchases) {
  const w = H.baseWorld();
  w.accounts.find(a => a.id === 'savings').value = savings;
  w.commitments = [
    { id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: 600, confidence: 'confirmed', sinkingFund: true, settledOn: '2026-10-12' },
    { id: 'gift', label: 'Invented gift', date: '2026-12-10', amount: 600, confidence: 'confirmed', sinkingFund: true },
  ];
  w.savingsPool = {};
  w.links = [TRIP_LINK];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    ...purchases.map(p => H.lm({ date: '2026-10-12', category: 'Trip', payee: 'Invented airline', ...p }))];
  return w;
}

// ------------------------------------------------- the page a household reads
(async () => {
  try {
    const read = async w => H.withBudget(w, async p => H.goal(await H.snap(p), 'Invented trip'));
    const five = await read(world(500, [{ amount: 500, account: 'savings' }]));
    assert.match(five, /Owner-confirmed paid \$500.00 Confirmed Oct 12 · Paid is linked Savings spending · Payment date Unknown/,
      '500: Paid is labelled as linked Savings spending; the payment date stays Unknown');
    assert.doesNotMatch(five, /Actual amount and date Unknown|over the|Observed linked spending/,
      '500: no Unknown-amount contradiction beside a known Paid, and no overspend note');
    const seven = await read(world(300, [{ amount: 700, account: 'savings' }]));
    assert.match(seven, /Owner-confirmed paid \$700.00 Confirmed Oct 12 .*\$100\.00 over the \$600\.00 planned cost \(disclosure, not another charge\)/,
      '700: the 100 over cost is a disclosure');
    assert.match(seven, /Still to fund \$0\.00/, '700: nothing more to fund');
    const chq = await read(world(1000, [{ amount: 500, account: 'chequing-b' }]));
    assert.match(chq, /Owner-confirmed paid Confirmed Oct 12 · Actual amount and date Unknown · Observed linked spending \$500\.00/,
      'chequing-only: the incumbent Unknown face is unchanged');
    // The goal window: the owner-confirmed state is named, and the Savings
    // balance line says it is what is held now (a paid goal may read $0 there).
    const popover = await H.withBudget(world(0, [{ amount: 500, account: 'savings' }]), async p => {
      await p.page.locator('button.blend-goal-row', { hasText: 'Invented trip' }).first().evaluate(node => node.click());
      const dialog = p.page.locator('dialog[data-blend-explain][open]');
      await dialog.waitFor();
      return dialog.evaluate(node => [...node.querySelectorAll('.blend-explain-fact dt')].map(dt => dt.textContent.trim()));
    });
    assert.ok(popover.includes('Owner-confirmed paid'), 'window labels the state Owner-confirmed paid: ' + popover);
    assert.ok(popover.includes('Held in Savings now'), 'window relabels Saved: ' + popover);
    assert.ok(!popover.includes('Paid') && !popover.includes('Saved'), 'no bare Paid or Saved label remains: ' + popover);
    console.log('savings owner-confirmed Paid: page checks passed');
  } finally {
    await H.closeBrowser();
  }
})().catch(e => { console.error(e); process.exit(1); });
