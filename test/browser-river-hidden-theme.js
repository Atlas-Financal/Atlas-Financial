'use strict';
/* The Budget river and a colour-scheme change while it has no size, in a real browser: real App.boot, the real
 * public/ files, invented data only (test/fixtures/budget-surface-data.js served for /data.json by route
 * interception; no server, no household data).
 *
 *   1. Under ?view=stack the current page (and its river) is hidden. Switching the colour scheme, and the page's own
 *      theme button, throw no page error. Before the fix, the hidden river rebuilt its geometry at zero width and
 *      createLinearGradient threw "non-finite" twice.
 *   2. Control, the current page: the river is shown, and a colour-scheme change still rebuilds it in the new theme
 *      (its data-river-theme follows), with no page error.
 *
 * Local (hosted CI has no browser). `node test/browser-river-hidden-theme.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');

const root = path.join(__dirname, '..');
let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2' };

async function open(browser, query) {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce', colorScheme: 'light' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== 'http://stack.test') return route.abort();
    if (u.pathname === '/data.json') return route.fulfill({ json: fx.served() });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
    const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
  });
  await page.goto('http://stack.test/' + query);
  await page.waitForSelector('.t-river canvas.river-canvas', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(300);
  return { page, errors };
}
const river = page => page.evaluate(() => {
  const host = document.querySelector('.t-river');
  const canvas = host && host.querySelector('canvas.river-canvas');
  return { theme: host ? host.dataset.riverTheme || null : null, width: canvas ? canvas.getBoundingClientRect().width : null };
});
const scheme = async (page, colorScheme) => { await page.emulateMedia({ colorScheme }); await page.waitForTimeout(300); };

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    console.log('1. ?view=stack: the hidden river and a colour-scheme change');
    {
      const { page, errors } = await open(browser, '?view=stack');
      await page.waitForSelector('#stack-root .wf-slab');
      const before = await river(page);
      ok(before.width === 0, 'the current page\'s river is present and hidden (zero width) under the Stack page', JSON.stringify(before));
      await scheme(page, 'dark');
      await scheme(page, 'light');
      const button = await page.$('[data-blend-theme]');
      ok(!!button, 'the page\'s theme button is there');
      await button.click(); await page.waitForTimeout(300);
      await button.click(); await page.waitForTimeout(300);
      ok(errors.length === 0, 'switching the colour scheme and the theme throws no page error', errors.join('; '));
      // A data refresh while hidden (the page re-renders, and the river is handed its periods again).
      await page.evaluate(() => App.rerender()); await page.waitForTimeout(300);
      await page.evaluate(() => App.rerender()); await page.waitForTimeout(300);
      ok(errors.length === 0, 'a re-render while the river is hidden throws no page error', errors.join('; '));
      await page.close();
    }
    console.log('2. control, the current page: a shown river still follows the colour scheme');
    {
      const { page, errors } = await open(browser, '');
      await page.waitForFunction(() => {
        const c = document.querySelector('.t-river canvas.river-canvas');
        return c && c.getBoundingClientRect().width > 0;
      }, null, { timeout: 15000 });
      const light = await river(page);
      await scheme(page, 'dark');
      const dark = await river(page);
      await scheme(page, 'light');
      const back = await river(page);
      ok(light.width > 0 && light.theme === 'light' && dark.theme === 'dark' && back.theme === 'light',
        'the shown river rebuilds in the new theme on each change', JSON.stringify([light, dark, back]));
      ok(errors.length === 0, 'no page error on the current page', errors.join('; '));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\nPASS River with no size and a colour-scheme change (${checks})`);
})().catch(error => { console.error(error); process.exit(1); });
