'use strict';
// Optional browser proof. Every request is confined to the synthetic server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const { fixture } = require('./fixtures/savings-earmarks');
const { withServer } = require('./test-savings-evidence-integration');
const shots = process.env.ATLAS_SAVINGS_SCREENSHOTS || path.join(os.tmpdir(), 'atlas-savings-earmarks-proof');
async function main() {
  fs.mkdirSync(shots, { recursive: true });
  await withServer(fixture(), async server => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
    try {
      for (const width of [1440, 390, 320]) {
        const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 400,
          hasTouch: width < 400, reducedMotion: 'reduce' });
        const split = server.cookie.indexOf('=');
        await context.addCookies([{ name: server.cookie.slice(0, split), value: server.cookie.slice(split + 1),
          url: server.base, httpOnly: true, sameSite: 'Lax' }]);
        await context.route('**/*', route => new URL(route.request().url()).origin === server.base ? route.continue() : route.abort());
        const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
        for (const mode of ['backed', 'deficit', 'stale', 'object-update-only', 'pending', 'intent-unknown', 'setup-unknown', 'hostile']) {
          const input = fixture(), a = input.payload.accounts.find(row => row.id === 1003);
          if (mode === 'deficit') a.balance = 200;
          // A pool balance is dated by its semantic balance date (balance_last_update here), never by
          // the object update time (N1, 2b8b4ed7). 'stale' moves the date that counts; 'object-update-only'
          // moves only updated_at, which must leave the balance current.
          if (mode === 'stale') a.balance_last_update = '2026-08-19T17:55:00.000Z';
          if (mode === 'object-update-only') a.updated_at = '2026-08-19T17:55:00.000Z';
          if (mode === 'pending') input.payload.transactions.push({ id: 95001, account_id: 1003, date: '2026-08-20', amount: 2.09, payee: 'Synthetic withdrawal', is_pending: true });
          if (mode === 'intent-unknown') input.data.plan.savingsEarmarks.history = [];
          if (mode === 'setup-unknown') { delete input.data.plan.savingsEarmarks; input.map.mappings.pop(); input.payload.accounts.pop(); }
          if (mode === 'hostile') input.data.plan.savingsEarmarks.pools[0].label = '<img src=x onerror=alert(1)>' + 'LongPoolName'.repeat(8);
          server.write(input);
          for (const [name, route] of [['budget', '/']]) {
            // The pools inventory lives only in the legacy Savings accounts disclosure, which the
            // Budget face clips off-screen (budget-blend.css) and keeps out of the Tab order.
            // Whether to show it is an owner decision (BACKLOG); this proof reads that one copy's
            // printed text without needing to reach it.
            await page.goto(server.base + route);
            const inventory = page.locator('.budget-savings-accounts [data-savings-inventory]');
            await inventory.waitFor({ state: 'attached' });
            assert.equal(await inventory.count(), 1, 'one legacy pools inventory');
            await inventory.evaluate(node => node.querySelectorAll('details').forEach(d => { d.open = true; }));
            const text = (await inventory.textContent()).replace(/\s+/g, ' ');
            if (mode === 'backed') { assert.match(text, /\$53\.37/); assert.match(text, /Currently backed: \$169\.37/); }
            if (mode === 'deficit') { assert.match(text, /Pool deficit/); assert.match(text, /\$47\.80/); assert.match(text, /Currently backed: Unknown/); }
            if (mode === 'stale') {
              assert.match(text, /Stale balance/);
              assert.match(text, /Balance evidence: 2026-08-19/);
              assert.match(text, /Observed pool cashUnknown unknown/, 'a day-old pool balance is not shown as a current figure');
              assert.doesNotMatch(text, /\$301\.17 verified/, 'a day-old pool balance is never verified-current');
            }
            if (mode === 'object-update-only') {
              assert.doesNotMatch(text, /Stale balance/, 'the object update time does not date the balance');
              assert.match(text, /Balance evidence: 2026-08-20 · CAD Observed pool cash\$301\.17 verified/);
            }
            if (mode === 'pending') assert.match(text, /Pending evidence/);
            if (mode === 'setup-unknown') assert.match(text, /have not been confirmed/);
            if (mode === 'intent-unknown') assert.match(text, /Assignments unknown/);
            if (mode === 'hostile') assert.equal(await inventory.locator('img').count(), 0);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ' ' + mode + ' has no overflow at ' + width);
            if (await inventory.locator('details').count()) assert.match(text, /Existing goal requirement/);
            await page.screenshot({ path: path.join(shots, name + '-' + width + '-' + mode + '.png') });
          }
        }
        assert.deepEqual(errors, [], 'no full-page browser runtime errors'); await context.close();
      }
    } finally { await browser.close(); }
  });
  console.log('PASS browser savings inventory: authenticated Budget, desktop/390/320px, backed/deficit/stale/object-update-only/pending/unknown/hostile states and no runtime errors; screenshots ' + shots);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
