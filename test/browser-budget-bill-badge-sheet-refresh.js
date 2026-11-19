'use strict';
// Browser proof: a bill's status badge survives a refresh while its sheet is open.
// budget-polish.js badges bill rows inside the waterfall; an open detail sheet holds
// the bill outside it, so before this fix App.rerender() left the fresh sheet row
// with the plain "· to confirm" label. Invented fixture (budget-surface-data),
// every request intercepted. Run by hand:
// NODE_PATH=<Playwright modules> CHROME_PATH=<Chromium> node test/browser-budget-bill-badge-sheet-refresh.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');
const root = path.join(__dirname, '..');
const norm = text => String(text || '').replace(/\s+/g, ' ').trim();
const TRIGGER = '.blend-bill-item[data-blend-bill="hydro:2026-08-18"]';
const SHEET_ROW = '[data-budget-detail-body] [data-period-bill="hydro"][data-bill-status]';

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const errors = [], external = [];
  let failures = 0;
  const ok = (cond, label, detail = '') => {
    if (!cond) failures++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  };
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      page.on('pageerror', err => errors.push(err.message));
      const data = fx.served();
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.origin !== 'http://budget.test') { external.push(u.origin); return route.abort(); }
        if (u.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
        const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.css')
          ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'text/html' });
      });
      await page.goto('http://budget.test/?view=classic');
      await page.locator('[data-blend-rings]').waitFor();
      const row = sel => page.evaluate(s => {
        const rows = [...document.querySelectorAll(s)];
        return rows.map(r => ({ text: r.textContent.replace(/\s+/g, ' ').trim(),
          badges: [...r.querySelectorAll('[data-atlas-bill-state]')].map(b => b.textContent.trim()) }));
      }, sel);
      const source = await row('[data-calendar-waterfall] [data-period-bill="hydro"][data-bill-status]');
      ok(source.length === 1 && source[0].badges.join() === 'To confirm', `${width}px: positive control, the source row carries the To confirm badge`, JSON.stringify(source));
      const trigger = page.locator(TRIGGER);
      await trigger.scrollIntoViewIfNeeded();
      await trigger.focus();
      await page.keyboard.press('Enter');
      await page.locator('[data-budget-detail-sheet][open]').waitFor({ state: 'visible' });
      const opened = await row(SHEET_ROW);
      ok(opened.length === 1 && opened[0].badges.join() === 'To confirm', `${width}px: the open sheet shows the badge`, JSON.stringify(opened));
      await page.evaluate(() => { window.__beforeRefresh = document.querySelector('[data-budget-detail-body] [data-period-bill="hydro"]'); });
      await page.evaluate(() => App.rerender());
      await page.waitForFunction(s => {
        const r = document.querySelector(s);
        return document.querySelector('[data-budget-detail-sheet]')?.open && r && r !== window.__beforeRefresh;
      }, SHEET_ROW);
      await page.waitForFunction(s => !!document.querySelector(s + ' [data-atlas-bill-state]'), SHEET_ROW, { timeout: 3000 }).catch(() => {});
      const refreshed = await row(SHEET_ROW);
      ok(refreshed.length === 1 && refreshed[0].badges.join() === 'To confirm', `${width}px: after a refresh the fresh sheet row keeps exactly one badge`, JSON.stringify(refreshed));
      ok(refreshed.length === 1 && !/·\s*to confirm/i.test(refreshed[0].text) && /−\$120\.00/.test(refreshed[0].text),
        `${width}px: the refreshed row reads like its source (no plain "· to confirm" label; same amount)`, refreshed[0] && refreshed[0].text);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('[data-budget-detail-sheet]')?.open);
      const back = await row('[data-calendar-waterfall] [data-period-bill="hydro"][data-bill-status]');
      ok(back.length === 1 && back[0].badges.join() === 'To confirm', `${width}px: after closing, the source row has one badge, not two`, JSON.stringify(back));
      ok(norm(back[0] && back[0].text) === norm(source[0].text), `${width}px: the source row reads as before`);
      await page.close();
    }
    ok(errors.length === 0, 'no page errors', errors.join('; '));
    ok(external.length === 0, 'no request left the invented origin', external.join(', '));
  } catch (e) {
    failures++; console.error(e);
  } finally {
    await browser.close();
  }
  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nPASS bill badge survives sheet refresh browser proof');
})();
