'use strict';
// Savings audit PR 1, through the Budget page a household reads. Real page,
// invented household from test/acceptance/harness.js; no household figure
// enters this file.
//
//   node test/browser-savings-paid-spend-once.js
//
// Given payroll 1,400, a plan of Groceries 300 + Eating out 100 and Savings
// 1,000. When the household pays an unlinked 200 "Gifts" purchase from
// Savings (observed Savings 1,000 -> 800), Then, by hand:
//   - the household reserve stays 400 (the control), never 600;
//   - Balance After Deductions stays 1,400 - 0 - 400 = 1,000, never 800;
//   - the purchase is listed once, marked "Paid from Savings", 200;
//   - Savings reads the observed 800: the 200 left household money once.
const H = require('./acceptance/harness.js');

function world(paidFromSavings) {
  const w = H.baseWorld();
  w.savingsPool = {};
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  if (paidFromSavings) {
    w.accounts.find(a => a.id === 'savings').value = 800;
    w.transactions.push(H.lm({ date: '2026-10-12', amount: 200, category: 'Gifts', account: 'savings', payee: 'Invented giftshop' }));
  }
  return w;
}
const bad = s => (s.all.match(/Balance After Deductions\s*(\$[\d,]+\.\d\d)/) || [])[1] || '';
const reserve = s => (s.household.match(/Protective spending reserve\s*(\$[\d,]+\.\d\d)/) || [])[1] || '';

(async () => {
  let failed = 0;
  const run = async (name, fn) => {
    try { await fn(); console.log('ok   ' + name); } catch (e) { failed += 1; console.log('FAIL ' + name + ': ' + e.message); }
  };
  await run('control: no Savings purchase', () => H.withBudget(world(false), async p => {
    const s = await H.snap(p);
    H.expect(reserve(s) === '$400.00', `reserve is 400 (got ${reserve(s)})`);
    H.expect(bad(s) === '$1,000.00', `Balance After Deductions is 1,000 (got ${bad(s)})`);
    H.expectExcludes(s.all, 'Paid from Savings', 'nothing is marked paid from Savings');
  }));
  await run('an unlinked purchase paid from Savings is counted once', () => H.withBudget(world(true), async p => {
    const s = await H.snap(p);
    H.expect(reserve(s) === '$400.00', `the reserve does not hold the Savings purchase (got ${reserve(s)})`);
    H.expect(bad(s) === '$1,000.00', `Balance After Deductions is not reduced (got ${bad(s)})`);
    H.expectIncludes(s.savings, '$800.00', 'Savings shows the observed 800');
    // Visible on the Budget as spending, marked paid from Savings.
    H.expectMatch(s.all, /Paid from Savings\s*\$200\.00\s*1 purchase/, 'the Spending view shows 200 paid from Savings');
    H.expectMatch(s.household, /Paid from Savings[^|]*Spent\s*\$200\.00/, 'the household evidence lists it as spent from Savings');
    H.expect(H.occurrences(s.all, 'Invented giftshop') === 1, `listed exactly once (got ${H.occurrences(s.all, 'Invented giftshop')})`);
    H.expectNoMatch(s.categories.join(' | '), /Other spending/, 'not also Other spending');
  }));
  // Atlas findings on 89fbdff: incomplete evidence, pending rows and the
  // cancelled-service warning.
  const variant = o => { const w = world(true);
    w.transactions[1] = H.lm({ date: '2026-10-12', amount: 200, category: 'Gifts', account: 'savings',
      payee: o.payee || 'Invented giftshop', pending: !!o.pending });
    if (o.truncated) w.coverage = { complete: false, hasMore: true };
    if (o.pendingUnknown) w.pendingCoverage = { basis: 'is_pending-unbounded', complete: false, hasMore: true };
    if (o.cancelled) w.planPatch = plan => { plan.cancelledServices = [{ id: 'inv-svc', label: 'Invented streaming',
      confirmedCancelledAsOf: '2026-10-01', merchantKeys: ['Invented streaming'] }]; };
    return w; };
  const text = p => p.page.evaluate(() => document.body.textContent.replace(/\s+/g, ' '));
  await run('incomplete evidence: Paid from Savings is Unavailable, 200 observed so far', () => H.withBudget(variant({ truncated: true }), async p => {
    const all = await text(p);
    H.expectMatch(all, /Paid from Savings Unavailable/, 'the total is Unavailable');
    H.expectMatch(all, /\$200\.00 observed so far/, 'the observed amount is a lower bound');
    H.expectNoMatch(all, /Paid from Savings \$200\.00/, 'never a complete $200.00 total');
  }));
  await run('unknown pending coverage: Paid from Savings is Unavailable, 200 posted so far', () => H.withBudget(variant({ pendingUnknown: true }), async p => {
    const all = await text(p);
    H.expectMatch(all, /Paid from Savings Unavailable/, 'the total is Unavailable');
    H.expectMatch(all, /\$200\.00 observed so far/, 'the posted amount is a lower bound');
  }));
  await run('pending: the row is never called settled', () => H.withBudget(variant({ pending: true }), async p => {
    const all = await text(p);
    H.expectMatch(all, /1 purchase is still pending, so the Savings balance may not reflect it yet/, 'pending disclosed');
    H.expectMatch(all, /Paid from Savings \$200\.00 1 purchase · 1 pending/, 'browse total marks it pending');
  }));
  await run('cancelled service: the unexpected-charge warning is kept', () => H.withBudget(variant({ cancelled: true, payee: 'Invented streaming' }), async p => {
    H.expectMatch(await text(p), /Unexpected charge from cancelled service: Invented streaming/, 'warning shown');
  }));
  await run('a pending row replaced by its posted successor counts as one purchase', () => {
    const w = world(true);
    w.transactions.push(H.lm({ date: '2026-10-12', amount: 200, category: 'Gifts', account: 'savings', payee: 'Invented giftshop', pending: true }));
    return H.withBudget(w, async p => {
      H.expectMatch(await text(p), /Paid from Savings \$200\.00 1 purchase(?! ·)/, 'one purchase of 200, not two and not pending');
    });
  });
  await H.closeBrowser();
  if (failed) { console.log(`${failed} case(s) failed`); process.exit(1); }
  console.log('Savings-paid spend through the Budget page: counted once.');
})();
