'use strict';
// Savings audit PR 3, through the Budget page a household reads. Real page,
// invented household from test/acceptance/harness.js; no household figure
// enters this file.
//
//   node test/browser-savings-saved-trust.js
//
// Given a Savings pool of 1,000, a 600 trip (Nov 20, ESTIMATED) and a 600
// gift (Dec 10, confirmed). Then, by hand: Saved is 600 / 400, and both are
// tagged estimated, because the gift's 400 is 1,000 minus the trip's
// estimated 600. With both needs confirmed, both stay calculated.
const H = require('./acceptance/harness.js');

function world(tripConfidence) {
  const w = H.baseWorld();
  w.savingsPool = {};
  w.commitments = [
    { id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: 600, confidence: tripConfidence, sinkingFund: true },
    { id: 'gift', label: 'Invented gift', date: '2026-12-10', amount: 600, confidence: 'confirmed', sinkingFund: true }];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  return w;
}

(async () => {
  let failed = 0;
  const run = async (name, fn) => {
    try { await fn(); console.log('ok   ' + name); } catch (e) { failed += 1; console.log('FAIL ' + name + ': ' + e.message); }
  };
  await run('an estimated earlier need makes both Saved figures estimated', () => H.withBudget(world('estimated'), async p => {
    const s = await H.snap(p);
    H.expectMatch(H.goal(s, 'Invented trip'), /^Invented trip\s*≈\s*estimated\s*\$600\.00\s*Saved/, 'trip Saved 600 is estimated');
    H.expectMatch(H.goal(s, 'Invented gift'), /^Invented gift\s*≈\s*estimated\s*\$400\.00\s*Saved/, 'gift Saved 400 is estimated');
    H.expectNoMatch(H.goal(s, 'Invented gift'), /calculated\s*\$400\.00\s*Saved/, 'gift Saved is not tagged calculated');
  }));
  await run('both needs confirmed: both Saved figures stay calculated', () => H.withBudget(world('confirmed'), async p => {
    const s = await H.snap(p);
    H.expectMatch(H.goal(s, 'Invented trip'), /calculated\s*\$600\.00\s*Saved/, 'trip Saved 600 calculated');
    H.expectMatch(H.goal(s, 'Invented gift'), /calculated\s*\$400\.00\s*Saved/, 'gift Saved 400 calculated');
  }));
  await H.closeBrowser();
  if (failed) { console.log(`${failed} case(s) failed`); process.exit(1); }
  console.log('Saved trust through the Budget page: follows estimated needs.');
})();
