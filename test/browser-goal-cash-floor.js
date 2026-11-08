'use strict';
// Real authenticated Plan page with an invented observation: a goal and the
// Unallocated ledger both subtract cash held for an uncovered card purchase.
// NODE_PATH=<playwright> CHROME_PATH=<chromium> node test/browser-goal-cash-floor.js
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { withServer } = require('./test-savings-evidence-integration');
const fixture = require('./fixtures/card-purchase-coverage-data');
function input(purchase) {
  const x = fixture();
  if (purchase) { x.payload.transactions[0].amount = 300; x.payload.accounts[3].balance = 700; }
  else { x.payload.transactions = []; x.payload.accounts[3].balance = 400; }
  x.data.plan.defaults.targetBuffer = 100; x.data.plan.obligations = []; x.data.plan.income = [];
  x.data.plan.commitments = [{ id: 'plan-a', label: 'Invented plan', date: '2026-09-21',
    amount: 200, confidence: 'confirmed' }];
  return { data: x.data, payload: x.payload, map: x.accountMap };
}
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const errors = [];
  try {
    for (const [purchase, verdict, ledger] of [
      [true, /FUNDING GAP[\s\S]*Invented plan[\s\S]*Gap \$100\.00/, /Cash held for card purchases\s*− \$300\.00[\s\S]*= Unallocated\s*−\$100\.00/],
      [false, /ON TRACK[\s\S]*Invented plan[\s\S]*Margin \$200\.00/, /^(?![\s\S]*Cash held for card purchases)[\s\S]*= Unallocated\s*\$200\.00/],
    ]) {
      await withServer(input(purchase), async server => {
        for (const width of [1440, 390]) {
          const context = await browser.newContext({ viewport: { width, height: 1000 } });
          const [name, value] = server.cookie.split('=');
          await context.addCookies([{ name, value, url: server.base, httpOnly: true }]);
          const page = await context.newPage();
          page.on('pageerror', e => errors.push(e.message));
          await page.goto(server.base + '/');
          await page.locator('#priorities-ledger .row, #priorities-ledger div').first().waitFor({ state: 'attached' });
          await page.locator('#major-plans-list .fund').first().waitFor({ state: 'attached' });
          assert.match(await page.locator('#major-plans-list').textContent(), verdict, 'goal verdict at ' + width);
          assert.match(await page.locator('#priorities-ledger').textContent(), ledger, 'ledger at ' + width);
          await context.close();
        }
      });
    }
    assert.deepEqual(errors, []);
    console.log('  PASS  browser: goal verdict and Unallocated use the one cash floor');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
