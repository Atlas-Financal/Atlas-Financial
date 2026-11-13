'use strict';
// Display-only proof: real App.boot / Forecast / Budget, invented data, no live calls.
// CAPTURE_ONLY=1 captures current-main defects without asserting the repairs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../acceptance/harness');
const annual = require('../fixtures/travel-visa-annual-fee-data');
const out = process.env.PROOF_DIR || '/tmp/budget-text-proof';
const captureOnly = process.env.CAPTURE_ONLY === '1';
fs.mkdirSync(out, { recursive: true });
const w = H.baseWorld();
w.commitments = [{ id: 'trip', label: 'Invented paid goal', date: '2026-11-20', amount: 200,
  confidence: 'confirmed', sinkingFund: true, settledOn: '2026-10-12' },
  { id: 'gift', label: 'Invented unpaid goal', date: '2026-12-10', amount: 600, confidence: 'confirmed', sinkingFund: true }];
w.savingsPool = {};
w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
async function capture(page, name) { await page.screenshot({ path: path.join(out, name + '.png'), fullPage: false }); }
(async () => {
  try {
    for (const width of [390, 1440]) {
      await H.withBudget(w, async p => {
        const page = p.page;
        await page.locator('[data-blend-goal="commitment:trip"]').click();
        // Explanation identity is the active dialog, independent of theme.
        const visible = page.locator('dialog[open]').last();
        await visible.waitFor({state:'visible'});
        await capture(page, `goal-${width}`);
        if (!captureOnly) {
          assert.doesNotMatch(await visible.innerText(), /Top-up|this period/);
          assert.match(await visible.innerText(), /owner-confirmed/);
          assert.match(await visible.innerText(), /Actual amount and date Unknown/);
        }
        await page.keyboard.press('Escape');
        await page.locator('[data-blend-goal="commitment:gift"]').click();
        if (!captureOnly) assert.match(await page.locator('dialog[open]').last().innerText(), /Top-up this period/,'unpaid top-up stays visible');
        await page.keyboard.press('Escape');
        await page.locator('[data-budget-browse="spending"] header').click();
        const sheet = page.locator('[data-budget-detail-sheet]');
        await sheet.waitFor({state:'visible'});
        const remain = sheet.locator('.blend-house-remain');
        await remain.waitFor({state:'visible'});
        const positions = await remain.evaluate(e => [...e.children].map(n => {const r=n.getBoundingClientRect();return {top:r.top,bottom:r.bottom,text:n.innerText};}));
        await capture(page, `household-${width}`);
        if (!captureOnly) {
          assert.ok(positions[1].top >= positions[0].bottom, JSON.stringify(positions));
          assert.ok(positions[2].top >= positions[1].bottom, JSON.stringify(positions));
        }
        await page.keyboard.press('Escape');
        assert.equal(await sheet.isVisible(), false);
        assert.deepEqual(p.errors, []);
      }, { width });
      const p = await H.openBudget(annual('ready').data, { width });
      try {
        await p.page.locator('[data-blend-bills-open]').click();
        const bucket = p.page.locator('[data-budget-detail-sheet] [data-budget-bill-bucket="upcoming"]');
        await bucket.waitFor({state:'visible'});
        await capture(p.page, `annual-${width}`);
        if (!captureOnly) assert.equal(await bucket.locator('h3').innerText(), 'Upcoming annual bills');
        assert.match(await bucket.innerText(), /149/);
        await p.page.keyboard.press('Escape');
        assert.deepEqual(p.errors, []);
      } finally { await p.close(); }
    }
    console.log(captureOnly ? 'Before screenshots captured' : 'Budget text polish: browser checks passed');
  } finally { await H.closeBrowser(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
