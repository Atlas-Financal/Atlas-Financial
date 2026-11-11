'use strict';
/* Browser Back closes an open Budget pop-up (Grok UI audit, 2026-11-11).
 * `node test/browser-budget-back-closes-sheet.js`  (CHROME_PATH=<Chromium> optional)
 *
 * Before this change the Budget pop-ups (the detail sheet, which is a
 * drawer on a phone, and the explain window) held no history entry, so
 * the browser's Back left the app while one was open. Through the real
 * page, at 1440px and at 390px with touch, this proves:
 *   1. Back closes an open detail sheet, the explain window, and each pop-up
 *      kind the face opens (Bills, a household category, a credit card, a
 *      savings goal), staying on the page without a reload;
 *   2. Forward afterwards reopens nothing and reloads nothing;
 *   3. a nested sheet (a bill opened inside the Bills panel) steps back to
 *      its parent on the first Back, and the second Back closes it;
 *   4. a pop-up closed by its × or by Escape spends its entry: the next Back
 *      leaves the page (the history is not padded with dead entries);
 *   5. nothing is reloaded: a marker set on the page survives every step.
 *
 * Invented fixture only (test/fixtures/budget-surface-data.js); a blank
 * page precedes the app in history, so "leaves the page" is observable.
 * Nothing rendered is printed.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');

const root = path.join(__dirname, '..');
let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

async function open(browser, width, touch) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: touch, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin === 'http://blank.test') return route.fulfill({ body: '<!doctype html><title>before</title>', contentType: 'text/html' });
    if (u.origin !== 'http://budget.test') return route.abort();
    if (u.pathname === '/data.json') return route.fulfill({ json: fx.served({}) });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
    const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript'
      : file.endsWith('.png') ? 'image/png' : file.endsWith('.woff2') ? 'font/woff2'
      : file.endsWith('.woff') ? 'font/woff' : 'text/html';
    return route.fulfill({ body: fs.readFileSync(file), contentType: type });
  });
  await page.goto('http://blank.test/');
  await page.goto('http://budget.test/');
  await page.locator('[data-budget-surface]').waitFor();
  await page.waitForTimeout(400);
  await page.evaluate(() => { window.__noReload = true; });
  return { page, context, errors };
}

const settle = page => page.waitForTimeout(350);
const facts = page => page.evaluate(() => ({
  url: location.href,
  alive: window.__noReload === true,
  open: [...document.querySelectorAll('dialog[open]')].length,
  nested: !!document.querySelector('dialog[open] [data-budget-detail-back]:not([hidden])'),
}));
const tap = async (page, locator, touch) => {
  await locator.scrollIntoViewIfNeeded();
  if (touch) await locator.tap(); else await locator.click();
  await settle(page);
};

(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  try {
    for (const [width, touch] of [[1440, false], [390, true]]) {
      const where = `${width}px${touch ? ' touch' : ''}`;
      console.log(`\n=== ${where} ===`);
      const { page, context, errors } = await open(browser, width, touch);
      const home = page.url();

      const openers = [
        ['the Bills panel', '[data-blend-bills-open]'],
        ['a household category', '[data-blend-cat]'],
        ['a credit card', '[data-budget-card-toggle]'],
        ['a savings goal (explain window)', '[data-blend-goal]'],
      ];
      for (const [what, selector] of openers) {
        const opener = page.locator(selector).first();
        if (!(await opener.count())) { ok(false, `${what}: opener present`); continue; }
        await tap(page, opener, touch);
        let f = await facts(page);
        ok(f.open === 1, `${what}: opens`);
        await page.goBack({ waitUntil: 'commit' }).catch(() => {});
        await settle(page);
        f = await facts(page);
        ok(f.open === 0 && f.url === home && f.alive, `${what}: Back closes it and stays on the page`,
          `open ${f.open}, same page ${f.url === home}, not reloaded ${f.alive}`);
        await page.goForward({ waitUntil: 'commit' }).catch(() => {});
        await settle(page);
        f = await facts(page);
        ok(f.open === 0 && f.url === home && f.alive, `${what}: Forward reopens nothing and reloads nothing`,
          `open ${f.open}, not reloaded ${f.alive}`);
        // Leave the spent forward entry behind before the next case.
        await page.goBack({ waitUntil: 'commit' }).catch(() => {});
        await settle(page);
      }

      console.log('  -- nested sheet');
      await tap(page, page.locator('[data-blend-bills-open]').first(), touch);
      const bill = page.locator('dialog[open] [data-budget-bill-open]').first();
      if (await bill.count()) {
        await tap(page, bill, touch);
        let f = await facts(page);
        ok(f.open === 1 && f.nested, 'a bill opens nested inside the Bills panel');
        await page.goBack({ waitUntil: 'commit' }).catch(() => {});
        await settle(page);
        f = await facts(page);
        ok(f.open === 1 && !f.nested && f.alive, 'the first Back steps back to the Bills panel');
        await page.goBack({ waitUntil: 'commit' }).catch(() => {});
        await settle(page);
        f = await facts(page);
        ok(f.open === 0 && f.url === home && f.alive, 'the second Back closes the Bills panel');
      } else {
        ok(false, 'a nested bill opener is present in the Bills panel');
      }

      console.log('  -- closed by × or Escape, then Back leaves');
      for (const how of ['×', 'Escape']) {
        // A fresh page each time, so the only history is the blank page and the app.
        const fresh = await open(browser, width, touch);
        await tap(fresh.page, fresh.page.locator('[data-blend-bills-open]').first(), touch);
        if (how === '×') await tap(fresh.page, fresh.page.locator('dialog[open] [data-budget-detail-close]').first(), touch);
        else { await fresh.page.keyboard.press('Escape'); await settle(fresh.page); }
        const f = await facts(fresh.page);
        ok(f.open === 0, `closed with ${how}`);
        await fresh.page.goBack({ waitUntil: 'commit' }).catch(() => {});
        await fresh.page.waitForTimeout(400);
        const origin = new URL(fresh.page.url()).origin;
        ok(origin === 'http://blank.test', `after ${how}, one Back leaves the app`, origin);
        ok(fresh.errors.length === 0, `no page errors (${how} case)`);
        await fresh.context.close();
      }

      ok(errors.length === 0, 'no page errors', errors.length ? String(errors.length) : '');
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\n${checks} checks, ${failures} failed`);
  if (failures) process.exit(1);
  console.log('Browser Back closes Budget pop-ups.');
})().catch(err => { console.error(err); process.exit(1); });
