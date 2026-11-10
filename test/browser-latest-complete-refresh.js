'use strict';
// Standalone real-browser proof. Synthetic loopback provider + actual server,
// /data.json, App boot/Manual Refresh/reload and active Budget page.
// NODE_PATH=<Playwright packages> CHROME_PATH=<Chromium> node test/browser-latest-complete-refresh.js
// Not imported by npm test; this file has an explicit external browser dependency.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const Fixture = require('./fixtures/budget-surface-data');
const helpers = require('./test-server-observation-memory');
const out = process.env.ATLAS_LATEST_COMPLETE_PROOF_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-latest-complete-browser-'));
fs.mkdirSync(out, { recursive: true, mode: 0o700 }); fs.chmodSync(out, 0o700);
(async () => {
  let mock, site, browser;
  const errors = [];
  try {
    mock = await helpers.provider({ accountId: 501 }); site = await helpers.atlas(mock);
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    const split = site.cookie.indexOf('=');
    await context.addCookies([{ name: site.cookie.slice(0, split), value: site.cookie.slice(split + 1), url: site.base }]);
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    const refresh = async () => {
      const loaded = page.waitForEvent('load');
      await page.getByRole('button', { name: 'Manual Refresh', exact: true }).click(); await loaded;
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Manual Refresh' && !button.disabled));
    };
    await page.goto(site.base + '/');
    await page.waitForSelector('[data-budget-cash-hero]');
    assert.match(await page.locator('[data-budget-cash-hero]').innerText(), /1,215\.00/);
    const before = await page.locator('[data-budget-cash-hero]').innerText();
    // STALE FIRST, deliberately different partial values cannot enter display.
    const stale = { ...Fixture.payload(), tags: [] };
    stale.accounts = stale.accounts.map(a => ({ ...a, balance: a.balance + 777, balance_last_update: '2026-08-19T17:55:00.000Z' }));
    mock.payload(stale);
    await refresh();
    await page.waitForSelector('[data-latest-complete-refresh]');
    assert.equal(await page.locator('[data-budget-cash-hero]').innerText(), before);
    const note = await page.locator('[data-latest-complete-refresh]').innerText();
    assert.match(note, /Aug 20, 2026/); assert.match(note, /11:00 a\.m\./); assert.match(note, /not current balances/);
    assert.match(await page.locator('[data-observation-check]').innerText(), /Current refresh incomplete/);
    await page.screenshot({ path: path.join(out, 'stale-retained-budget.png'), fullPage: true });
    for (const mode of ['postedIncomplete', 'incomplete', 'laterFailure', 'failure']) {
      mock.payload({ ...Fixture.payload(), tags: [] }); mock.mode(mode);
      await refresh();
      await page.waitForSelector('[data-latest-complete-refresh]');
      assert.equal(await page.locator('[data-budget-cash-hero]').innerText(), before);
      assert.match(await page.locator('[data-latest-complete-refresh]').innerText(), /Aug 20, 2026/);
    }
    // A later complete cohort replaces it. The new invented bank stock is
    // 1,215 + 123 = 1,338; no Forecast-derived expected figure is used.
    const later = { ...Fixture.payload(), tags: [] }; later.accounts.find(a => a.id === 1001).balance = 1215 + 123;
    mock.payload(later); mock.mode('ok');
    await refresh();
    await page.waitForSelector('[data-latest-complete-refresh]', { state: 'detached' });
    await page.waitForFunction(() => document.querySelector('[data-budget-cash-hero]')?.textContent.includes('1,338.00'));
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ syntheticOnly: true, staleFirst: true, failureModes: 5,
      actualServerAndBudget: true, originalDateAndTime: true, laterCompleteReplacement: true, pageErrors: errors }, null, 2), { mode: 0o600 });
    for (const name of fs.readdirSync(out)) fs.chmodSync(path.join(out, name), 0o600);
    console.log('Latest complete refresh real-browser proof passed.');
  } finally { await browser?.close(); await site?.close(); await mock?.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
