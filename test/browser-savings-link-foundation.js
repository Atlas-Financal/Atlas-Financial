'use strict';
// Existing App.boot and goal-dialog consumer, invented intercepted GETs only.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright');
const { fixture, observe, raw, link } = require('./test-savings-link-foundation');
const consumer = require('./fixtures/savings-daily-consumer-data');
const assets = path.resolve(__dirname, '../public');
const output = process.env.ATLAS_LINK_PROOF || path.join(require('node:os').tmpdir(), 'atlas-savings-link-proof');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const errors = [], external = [], writes = [], cases = [];
  try {
    for (const mode of ['posted', 'pending', 'conflict', 'no-links']) for (const width of [1280, 390, 320]) {
      const x = fixture(), data = consumer();
      if (mode === 'pending') x.payload.transactions = [raw({ is_pending: true })];
      if (mode === 'conflict') x.map.savingsLinks.links[1] = link('tag', 'far', '2026-10-28');
      if (mode === 'no-links') delete x.map.savingsLinks;
      data.plan = x.plan; data.meta.asOf = x.asOf; data.liveOverlay.currentPeriodActuals = observe(x);
      const page = await browser.newPage({ viewport: { width, height: 1100 }, reducedMotion: 'reduce' });
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== 'GET') { writes.push(request.method()); return route.abort(); }
        if (url.origin !== 'http://savings-links.test') { external.push(url.origin); return route.abort(); }
        if (url.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return route.fulfill({ json: null });
        const file = path.resolve(assets, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
        if (!file.startsWith(assets + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html' });
      });
      await page.goto('http://savings-links.test/');
      const button = page.locator('[data-budget-goal-open="group:club"]').first();
      await button.waitFor({ state: 'visible' }); await button.focus(); await page.keyboard.press('Enter');
      const dialog = page.locator('[data-budget-detail-sheet]'), body = dialog.locator('[data-budget-detail-body]');
      await dialog.waitFor({ state: 'visible' });
      const evidence = body.locator('[data-savings-link-evidence]').first();
      if (mode === 'no-links') assert.equal(await body.locator('[data-savings-link-evidence]').count(), 0);
      else {
        await evidence.locator('summary').click();
        const text = await evidence.innerText();
        assert.match(text, /Category link/); assert.match(text, /version 3; anchor revision 1/);
        assert.match(text, mode === 'posted' ? /Posted evidence/ : mode === 'pending' ? /Pending evidence/ : /Unresolved: Conflicting/);
        assert.equal(await evidence.locator('[data-savings-linked-transaction]').count(), 1, 'same-item dual link counts once');
        assert.doesNotMatch(text, /invented-provider|invented-category|invented-tag|invented-account/);
        await evidence.screenshot({ path: path.join(output, mode + '-' + width + '.png') });
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no page overflow');
      cases.push({ mode, width }); await page.close();
    }
  } finally { await browser.close(); }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(writes, []);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ cases, errors, external, writes }));
  console.log('Savings link browser proof: 12 cases, real goal dialog, no external requests or writes; ' + output);
})().catch(error => { console.error(error); process.exitCode = 1; });
