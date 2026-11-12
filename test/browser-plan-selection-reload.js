'use strict';
// Actual-page proof: the selected pay period survives a reload in the same
// tab, an unknown stored id falls back to the current period and clears the
// stored value, and a throwing sessionStorage still renders the current
// period. Invented fixture; every request is intercepted; no server.
// CHROME_PATH=<Chromium executable> node test/browser-plan-selection-reload.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');
const root = path.join(__dirname, '..');
const KEY = 'atlas.planSelection.v1';
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 1000 }, reducedMotion: 'reduce' });
    page.on('pageerror', err => errors.push(err.message));
    await page.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.origin !== 'http://budget.test') return route.abort();
      if (u.pathname === '/data.json') return route.fulfill({ json: fx.served() });
      if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) {
        return route.fulfill({ json: null });
      }
      const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.css')
        ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'text/html' });
    });
    const swipe = page.locator('[data-pay-period-swipe]');
    const selected = async () => {
      await page.locator('[data-budget-surface]').waitFor();
      return swipe.getAttribute('data-selected-pay-period');
    };
    // The river is the household's period control; move it with the keyboard.
    const move = async key => {
      const before = await selected();
      await page.locator('.river').focus();
      await page.keyboard.press(key);
      await page.waitForFunction(b => document.querySelector('[data-pay-period-swipe]')
        .getAttribute('data-selected-pay-period') !== b, before);
    };
    const stored = () => page.evaluate(k => sessionStorage.getItem(k), KEY);
    const load = async () => { await page.goto('http://budget.test/'); return selected(); };

    const current = await load();
    assert.equal(await stored(), null, 'nothing is stored until the household moves');
    // Future selection survives a reload.
    await move('ArrowRight');
    const future = await selected();
    assert.notEqual(future, current);
    assert.deepEqual(JSON.parse(await stored()), { look: 'this-period', periodId: future },
      'only the look and the period id are stored');
    await page.reload();
    assert.equal(await selected(), future, 'future period kept across reload');
    // Past selection survives a reload.
    await move('ArrowLeft');
    await move('ArrowLeft');
    const past = await selected();
    assert.notEqual(past, current);
    assert.notEqual(past, future);
    await page.reload();
    assert.equal(await selected(), past, 'past period kept across reload');
    // Returning to the current period still reloads on the current period.
    await move('ArrowRight');
    assert.equal(await selected(), current);
    await page.reload();
    assert.equal(await selected(), current);
    // An id Forecast does not serve falls back to current and is cleared.
    await page.evaluate(k => sessionStorage.setItem(k, JSON.stringify({ look: 'this-period', periodId: 'no-such-period' })), KEY);
    await page.reload();
    assert.equal(await selected(), current, 'unknown id falls back to the current period');
    assert.equal(await stored(), null, 'unknown id is cleared from storage');
    await page.evaluate(k => sessionStorage.setItem(k, JSON.stringify({ look: 'bogus:look', periodId: null })), KEY);
    await page.reload();
    assert.equal(await selected(), current);
    assert.equal(await stored(), null, 'unknown look is cleared from storage');
    await page.evaluate(k => sessionStorage.setItem(k, '{not json'), KEY);
    await page.reload();
    assert.equal(await selected(), current, 'corrupt stored value is ignored');
    // Storage that throws on every access still renders the current period
    // and moving between periods still works in memory.
    const thrower = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8') && `
      const boom = () => { throw new DOMException('blocked', 'SecurityError'); };
      Object.defineProperty(window, 'sessionStorage', { get: boom, configurable: true });`;
    await page.addInitScript(thrower);
    assert.equal(await load(), current, 'throwing storage renders the current period');
    await move('ArrowRight');
    assert.notEqual(await selected(), current, 'selection still moves with storage blocked');
    assert.deepEqual(errors, [], 'no page errors');
    console.log('PASS  plan selection survives reload; unknown id falls back; blocked storage renders');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
