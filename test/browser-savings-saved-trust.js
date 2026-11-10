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
function world(H, tripConfidence) {
  const w = H.baseWorld();
  w.savingsPool = {};
  w.commitments = [
    { id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: 600, confidence: tripConfidence, sinkingFund: true },
    { id: 'gift', label: 'Invented gift', date: '2026-12-10', amount: 600, confidence: 'confirmed', sinkingFund: true }];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  return w;
}

async function runSavedTrustBrowserProof(H, report = () => {}) {
  const failures = [];
  const run = async (name, fn) => {
    H.resetCaptures();
    try { await fn(); report(name, null); } catch (error) { failures.push(name + ': ' + error.message); report(name, error); }
  };
  await run('an estimated earlier need makes both Saved figures estimated', () => H.withBudget(world(H, 'estimated'), async p => {
    const s = await H.snap(p);
    H.expectMatch(H.goal(s, 'Invented trip'), /^Invented trip\s*≈\s*estimated\s*\$600\.00\s*Saved/, 'trip Saved 600 is estimated');
    H.expectMatch(H.goal(s, 'Invented gift'), /^Invented gift\s*≈\s*estimated\s*\$400\.00\s*Saved/, 'gift Saved 400 is estimated');
    H.expectNoMatch(H.goal(s, 'Invented gift'), /calculated\s*\$400\.00\s*Saved/, 'gift Saved is not tagged calculated');
    // The funding panel prints the same Saved figures: same tag, never calculated.
    const backed = (await p.rows('[data-budget-funding-saved]')).join(' | ');
    H.expectMatch(backed, /estimated \$400\.00/, 'funding panel: the gift backing is estimated');
    H.expectNoMatch(backed, /calculated/, 'funding panel: no Saved figure is tagged calculated');
    H.expectNoMatch(s.all, /Currently backed\s*\$[\d,]+\.\d\d\s*calculated/, 'no Currently backed figure is tagged calculated');
  }));
  await run('both needs confirmed: both Saved figures stay calculated', () => H.withBudget(world(H, 'confirmed'), async p => {
    const s = await H.snap(p);
    H.expectMatch(H.goal(s, 'Invented trip'), /calculated\s*\$600\.00\s*Saved/, 'trip Saved 600 calculated');
    H.expectMatch(H.goal(s, 'Invented gift'), /calculated\s*\$400\.00\s*Saved/, 'gift Saved 400 calculated');
    const backed = (await p.rows('[data-budget-funding-saved]')).join(' | ');
    H.expectMatch(backed, /calculated \$400\.00/, 'funding panel: gift backing stays calculated');
  }));
  // Atlas finding on 6c47dda: grouped members. One group, pool 1,000: earlier
  // need 550 estimated, later need 550 confirmed. By hand: 550 then
  // min(550, 1,000 - 550) = 450, and the later 450 depends on the earlier
  // estimate. Every surface that prints a member's Saved (goal member row and
  // inventory "Currently backed") must say estimated, never calculated.
  await run('grouped members: the later member Saved 450 is estimated on every surface', () => {
    const w = H.baseWorld();
    w.savingsPool = {};
    w.commitments = [
      { id: 'early', label: 'Invented early part', group: 'club', date: '2026-11-20', amount: 550, confidence: 'estimated', sinkingFund: true },
      { id: 'late', label: 'Invented late part', group: 'club', date: '2026-12-10', amount: 550, confidence: 'confirmed', sinkingFund: true }];
    w.groups = [{ id: 'club', label: 'Invented club', planSpendSummary: true }];
    w.planPatch = plan => { plan.savingsEarmarks.pools[0].goalRefs = [{ kind: 'group', id: 'club' }]; };
    w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
    return H.withBudget(w, async p => {
      const s = await H.snap(p);
      H.expectMatch(H.goal(s, 'Invented club'), /^Invented club\s*≈\s*estimated\s*\$1,000\.00\s*Saved/, 'estimated group Saved total is shown on the goal');
      const all = await p.page.evaluate(() => document.body.textContent.replace(/\s+/g, ' '));
      H.expectMatch(all, /Invented late part Dec 10 ≈ estimated \$450\.00/, 'goal member row: the later Saved 450 is estimated');
      H.expectMatch(all, /Invented late part 2026-12-10\s*Currently backed\s*\$450\.00 estimated/, 'inventory member: Currently backed 450 is estimated');
      H.expectNoMatch(all, /calculated \$450\.00/, 'no member Saved 450 is tagged calculated');
      H.expectNoMatch(all, /\$450\.00 calculated/, 'no Currently backed 450 is tagged calculated');
      const backed = (await p.rows('[data-budget-funding-saved]')).join(' | ');
      H.expectMatch(backed, /estimated \$450\.00/, 'grouped funding panel: later Saved 450 is estimated');
      H.expectNoMatch(backed, /calculated/, 'grouped funding panel never promotes Saved');
    });
  });
  await run('all-confirmed grouped members keep calculated Saved on every surface', () => {
    const w = H.baseWorld();
    w.savingsPool = {};
    w.commitments = [
      { id: 'early', label: 'Invented early part', group: 'club', date: '2026-11-20', amount: 550, confidence: 'confirmed', sinkingFund: true },
      { id: 'late', label: 'Invented late part', group: 'club', date: '2026-12-10', amount: 550, confidence: 'confirmed', sinkingFund: true }];
    w.groups = [{ id: 'club', label: 'Invented club', planSpendSummary: true }];
    w.planPatch = plan => { plan.savingsEarmarks.pools[0].goalRefs = [{ kind: 'group', id: 'club' }]; };
    w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
    return H.withBudget(w, async p => {
      const s = await H.snap(p);
      H.expectMatch(H.goal(s, 'Invented club'), /^Invented club\s*calculated\s*\$1,000\.00\s*Saved/, 'confirmed group Saved total stays calculated');
      const all = await p.page.evaluate(() => document.body.textContent.replace(/\s+/g, ' '));
      H.expectMatch(all, /Invented late part Dec 10 calculated \$450\.00/, 'confirmed goal member Saved 450 stays calculated');
      H.expectMatch(all, /Invented late part 2026-12-10\s*Currently backed\s*\$450\.00 calculated/, 'confirmed inventory member Saved 450 stays calculated');
      const backed = (await p.rows('[data-budget-funding-saved]')).join(' | ');
      H.expectMatch(backed, /calculated \$450\.00/, 'confirmed grouped funding Saved 450 stays calculated');
      H.expectNoMatch(backed, /estimated/, 'confirmed grouped funding Saved is not downgraded');
    });
  });
  if (failures.length) throw new Error(failures.length + ' Saved-trust browser case(s) failed: ' + failures.join(' | '));
}

// The hosted acceptance gate and standalone command execute the same page
// proof. Importing this module never launches a browser or closes one owned
// by the caller; the acceptance harness retains its existing lifecycle.
module.exports = { runSavedTrustBrowserProof };
if (require.main === module) {
  const H = require('./acceptance/harness.js');
  (async () => {
    try {
      await runSavedTrustBrowserProof(H, (name, error) => console.log((error ? 'FAIL ' : 'ok   ') + name + (error ? ': ' + error.message : '')));
      console.log('Saved trust through the Budget page: follows estimated needs.');
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    } finally {
      await H.closeBrowser().catch(error => { console.error(error.message); process.exitCode = 1; });
    }
  })();
}
