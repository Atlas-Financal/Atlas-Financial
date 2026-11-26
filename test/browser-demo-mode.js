'use strict';

// Run with Playwright available and CHROME_PATH set for a system Chromium.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { launch, demoPackage } = require('./lib/demo-process');
const fixture = require('./fixtures/figures-inputs/stack-card-summary.json');

async function main() {
  const { directory, clean } = demoPackage();
  const child = launch({ ATLAS_DEMO: '1' }, ['--require', path.join(__dirname, 'lib', 'demo-preload.js')], directory);
  let browser;
  try {
    const base = await child.ready;
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const errors = [];
    const unexpected = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const request = route.request();
      if (new URL(request.url()).origin === base && request.method() === 'GET') return route.continue();
      unexpected.push(`${request.method()} ${request.url()}`);
      return route.abort();
    });
    const packet = page.waitForResponse(base + '/data.json');
    const history = page.waitForResponse(base + '/periods.json');
    const response = await page.goto(base + '/');
    assert.equal(response.status(), 200);
    assert.equal(response.headers()['set-cookie'], undefined);
    assert.equal(new URL(page.url()).pathname, '/');
    assert.deepEqual(await (await packet).json(), fixture.data);
    assert.equal(await (await history).json(), fixture.periods);
    const banner = page.locator('#atlas-demo-banner');
    await banner.waitFor({ state: 'visible' });
    assert.equal(await banner.innerText(), 'Demo — made-up numbers, not a real household.');
    await page.getByRole('heading', { name: 'Budget', exact: true }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-stack-refresh]').isVisible(), false);
    assert.equal(await page.getByLabel('Password', { exact: true }).count(), 0);
    await page.goto(base + '/?view=classic');
    const balance = page.locator('[data-budget-card-toggle="travelvisa"] .card-movement-balance');
    await balance.waitFor({ state: 'visible' });
    assert.equal(await balance.innerText(), '$927.40');
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    assert.doesNotMatch(child.output, /Unexpected I\/O/);
    console.log('PASS  browser opens the demo Budget and shows the banner and invented $927.40 balance');
  } finally {
    try { await browser?.close(); } finally {
      try { await child.stop(); } finally { clean(); }
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
