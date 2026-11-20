'use strict';
// Isolated component browser proof, NOT production Budget wiring.
// CHROME_PATH=/usr/bin/chromium node test/browser-bill-detail.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { fixture, publishedRow } = require('./test-bill-detail');
const root = path.join(__dirname, '..');

(async () => {
  const data = fixture(), bill = publishedRow(data);
  const initial = JSON.stringify({ data, bill });
  const host = `<!doctype html><html lang="en"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Synthetic bill disclosure test</title><link rel="stylesheet" href="/bill-detail.css">
    <body><main><h1>Bill details fixture</h1><button id="period">Switch period</button>
    <button id="refresh">Refresh fixture</button><div id="bills"></div></main>
    <script src="/bill-detail.js"></script><script src="/fixture.js"></script></body></html>`;
  const script = `const initial = ${initial};
    let data = structuredClone(initial.data), bill = structuredClone(initial.bill), future = false;
    const before = JSON.stringify(data);
    function render() {
      document.querySelector('#bills').innerHTML = BillDetail.html(bill, data,
        { label: bill.label + ' · ' + bill.status, amount: 'Published amount' });
    }
    document.querySelector('#period').onclick = () => {
      future = !future;
      bill = future ? { ...initial.bill, date: '2026-09-02', status: 'still-due',
        settlement: 'upcoming', actual: 0, remaining: 100 } : structuredClone(initial.bill);
      render();
    };
    document.querySelector('#refresh').onclick = () => {
      data.liveOverlay.currentPeriodActuals.representedActuals = [];
      render();
    };
    render();`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const files = { '/bill-detail.js': 'public/bill-detail.js', '/bill-detail.css': 'public/bill-detail.css' };
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(host); }
    if (url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(script); }
    if (files[url.pathname]) {
      res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      return res.end(fs.readFileSync(path.join(root, files[url.pathname])));
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const errors = [], external = [];
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox'] });
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const width of [1280, 390, 320]) {
      const context = await browser.newContext({ viewport: { width, height: 850 },
        hasTouch: width < 400, isMobile: width < 400 });
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin !== base) {
          external.push(route.request().url()); return route.abort();
        }
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + '/?view=classic');
      const details = page.locator('[data-bill-detail]'), summary = details.locator(':scope > summary');
      assert.equal(await details.evaluate(el => el.open), false);
      assert.ok((await summary.boundingBox()).height >= 44, 'phone tap target');
      await summary.focus();
      await page.keyboard.press('Enter');
      assert.equal(await details.evaluate(el => el.open), true);
      assert.equal(await summary.evaluate(el => el === document.activeElement), true);
      assert.match(await details.innerText(), /2026-08-18/);
      assert.match(await details.innerText(), /\$97.50/);
      await page.keyboard.press('Space');
      await page.waitForFunction(() => !document.querySelector('[data-bill-detail]').open);
      if (width < 400) await summary.tap(); else await summary.click();
      assert.equal(await details.evaluate(el => el.open), true);
      assert.equal(await page.evaluate(() => JSON.stringify(data) === before), true, 'opening/closing is read-only');
      await page.locator('#period').click();
      assert.equal(await details.evaluate(el => el.open), false, 'period change closes old disclosure');
      await summary.click();
      assert.match(await details.innerText(), /2026-09-02/);
      assert.match(await details.innerText(), /Missing evidence does not mean unpaid/);
      assert.doesNotMatch(await details.innerText(), /2026-08-18|Posted/);
      await page.locator('#period').click();
      await summary.click();
      assert.match(await details.innerText(), /2026-08-18/);
      await page.locator('#refresh').click();
      assert.equal(await details.evaluate(el => el.open), false, 'refresh closes old disclosure');
      await summary.click();
      assert.match(await details.innerText(), /marked PAID by Forecast\. Transaction evidence is unavailable/);
      assert.doesNotMatch(await details.innerText(), /Transaction date|2026-08-18/);
      await page.evaluate(() => {
        bill.label = '<img src=x onerror="window.hacked=true">' + 'Long title '.repeat(16);
        bill.payerLabel = '<svg onload="window.hacked=true">';
        render();
      });
      await summary.click();
      assert.equal(await details.locator('img,svg').count(), 0);
      assert.equal(await page.evaluate(() => window.hacked === true), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
        'no horizontal overflow at phone width, including hostile long text');
      await context.close();
    }
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log('PASS isolated bill disclosure browser: 1280/390/320px, keyboard Enter/Space, tap, open/close, refresh, period switch, hostile text, no stale evidence or input mutation');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
