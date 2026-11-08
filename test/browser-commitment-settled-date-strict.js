'use strict';
// Real Budget main view, invented data: a 500 requirement whose settledOn is
// '2026-09-31' (no such day) renders exactly as an unsettled requirement,
// and the goal stays listed instead of vanishing.
// NODE_PATH=<playwright> CHROME_PATH=<chromium> node test/browser-commitment-settled-date-strict.js
const assert = require('node:assert/strict');
const H = require('./acceptance/harness');
function world(settledOn) {
  const w = H.baseWorld();
  w.commitments = [{ id: 'tickets', label: 'Invented tickets', date: '2026-10-20', amount: 500,
    confidence: 'confirmed', ...(settledOn ? { settledOn } : {}) }];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  return w;
}
(async () => {
  try {
    const page = async settledOn => H.withBudget(world(settledOn), async p => {
      const text = await p.text();
      assert.deepEqual(p.errors, []);
      return text;
    });
    const unsettled = await page(null);
    assert.match(unsettled, /Invented tickets/);
    for (const bad of ['2026-09-31', '2026-02-31']) {
      assert.equal(await page(bad), unsettled, bad + ' renders as unsettled');
    }
    assert.doesNotMatch(await page('2026-10-12'), /Invented tickets/, 'a real confirmation date still settles');
    console.log('  PASS  browser: impossible settlement dates leave the requirement listed and unpaid');
  } finally { await H.closeBrowser(); }
})().catch(e => { console.error(e); process.exit(1); });
