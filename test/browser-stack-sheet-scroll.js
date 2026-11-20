'use strict';
/* The Stack sheets hold the page still, in a real browser (invented data only: test/fixtures/budget-surface-data.js is
 * served for /data.json by route interception; no server, no household data). The bug (iOS Safari, a Bill sheet): a swipe
 * on the open sheet scrolled the PAGE behind it, and the sheet's lower content could not be reached.
 *
 * At a short 390 x 300 viewport, so every sheet is longer than the screen, for each sheet kind (Bill, Budget, Mortgage,
 * Credit card line):
 *   1. With the page scrolled down, opening a sheet fixes the body in place at the old position, with the sheet
 *      capped at 90dvh and its own overflow-y:auto and overscroll-behavior:contain.
 *   2. A wheel scroll on the sheet scrolls the sheet (its content can be reached), never the page behind it; a wheel on
 *      the scrim outside the sheet moves nothing either.
 *   3. Closing (Escape, the close button, the scrim) restores the page to the position it had, and unlocks the body.
 *   4. MUTANT: the same scenario against a copy of stack-sheet.js without the lock must FAIL checks 1, 2 and 3.
 *
 * `node test/browser-stack-sheet-scroll.js` (CHROME_PATH=<chrome> when playwright's own browser is not installed)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');

const root = path.join(__dirname, '..');
const H = 300; // a short phone viewport, so even the shortest sheet is taller than the screen
let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };

// Invented credit lines, so the Credit card sheet exists even where Forecast publishes none.
const STUB = `;(function (F) {
  if (!F || typeof F.stackCreditLines === 'function') return;
  const fig = (amount, trust) => ({ amount, trust: trust || 'calculated', reasons: [] });
  F.stackCreditLines = () => ({ lines: [
    { id: 'cashback', label: 'Green Card', paid: fig(100), spent: fig(260), net: fig(160), minimum: fig(30), toGo: fig(160), status: 'to-go',
      minimumCovered: { value: true, trust: 'calculated', reasons: [] }, transactions: [] }],
    totals: { paid: 100, spent: 260, trust: 'calculated', completeness: 'complete', excluded: [], reasons: [] } });
})(window.Forecast);\n`;

const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2' };
// `mutate` rewrites a served file, used only for the mutant run.
async function open(browser, mutate) {
  const page = await browser.newPage({ viewport: { width: 390, height: H }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== 'http://stack.test') return route.abort();
    if (u.pathname === '/data.json') return route.fulfill({ json: fx.served() });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
    const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
    let body = fs.readFileSync(file).toString('utf8');
    if (path.extname(file) === '.woff2') body = fs.readFileSync(file);
    else {
      if (u.pathname === '/forecast.js') body += STUB;
      if (mutate && u.pathname === '/stack-sheet.js') body = mutate(body);
    }
    return route.fulfill({ body, contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
  });
  await page.goto('http://stack.test/?view=stack');
  await page.waitForSelector('#stack-root [data-stack-card]', { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  return { page, errors };
}
const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
// Where the page content sits on the screen: unchanged while the page is held still, whatever the scroll mechanism.
const anchor = page => page.evaluate(() => Math.round(document.querySelector('#stack-root').getBoundingClientRect().top));

// One sheet of one kind: returns what held and what did not (booleans, never thrown), so the mutant can be judged too.
async function scenario(page, kind) {
  const r = {};
  await page.evaluate(() => { window.scrollTo(0, 0); });
  await page.evaluate(() => window.scrollTo(0, 260));
  await settle(page);
  const before = await page.evaluate(() => window.pageYOffset);
  r.scrolled = before > 100;
  const anchorBefore = await anchor(page);
  const opened = await page.evaluate(k => {
    const el = document.querySelector('#stack-root [data-stack-sheet^="' + k + ':"]');
    if (!el) return false;
    el.click();
    return !!document.querySelector('.stack-sheet');
  }, kind);
  if (!opened) return { missing: true };
  await settle(page);
  const sheetBox = await page.$eval('.stack-sheet', el => { const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return {
    top: b.top, height: b.height, scrollH: el.scrollHeight, clientH: el.clientHeight, overflowY: cs.overflowY, contain: cs.overscrollBehaviorY }; });
  const bodyPos = await page.evaluate(() => getComputedStyle(document.body).position);
  r.fixed = bodyPos === 'fixed' && (await anchor(page)) === anchorBefore;
  r.sheetCapped = sheetBox.height <= H * 0.9 + 1 && sheetBox.overflowY === 'auto' && sheetBox.contain === 'contain';
  r.longSheet = sheetBox.scrollH > sheetBox.clientH;
  // a wheel on the sheet: the sheet scrolls, the page does not
  await page.mouse.move(195, sheetBox.top + sheetBox.height / 2);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(150);
  const sheetTop = await page.$eval('.stack-sheet', el => el.scrollTop);
  r.sheetScrolls = sheetTop > 0;
  r.pageStillOnSheetWheel = (await anchor(page)) === anchorBefore;
  // a wheel on the scrim above the sheet: nothing moves
  await page.mouse.move(195, Math.max(2, Math.floor(sheetBox.top / 2)));
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(150);
  r.pageStillOnScrimWheel = (await anchor(page)) === anchorBefore;
  // close: the page returns to where it was
  await page.keyboard.press('Escape');
  await settle(page);
  r.closed = !(await page.$('.stack-sheet'));
  r.restored = Math.abs((await page.evaluate(() => window.pageYOffset)) - before) <= 1;
  r.unlocked = (await page.evaluate(() => getComputedStyle(document.body).position)) !== 'fixed';
  return r;
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
  try {
    const kinds = ['bill', 'budget', 'mortgage', 'card'];
    for (const kind of kinds) {
      console.log('sheet: ' + kind);
      const { page, errors } = await open(browser);
      const r = await scenario(page, kind);
      ok(!r.missing, kind + ': a row that opens the sheet is on the page');
      ok(r.scrolled && r.fixed, kind + ': opened with the page scrolled down, the body is fixed in place with the page where it was', JSON.stringify(r));
      ok(r.sheetCapped, kind + ': the sheet is capped at 90dvh with overflow-y:auto and overscroll-behavior:contain', JSON.stringify(r));
      ok(r.longSheet && r.sheetScrolls, kind + ': a wheel on the (longer than the screen) sheet scrolls the sheet', JSON.stringify(r));
      ok(r.pageStillOnSheetWheel && r.pageStillOnScrimWheel, kind + ': the page behind does not move for a wheel on the sheet or on the scrim', JSON.stringify(r));
      ok(r.closed && r.restored && r.unlocked, kind + ': closing restores the page position and unlocks the body', JSON.stringify(r));
      ok(errors.length === 0, kind + ': no page errors', errors.join('; '));
      await page.close();
    }

    console.log('close paths');
    {
      const { page } = await open(browser);
      await page.setViewportSize({ width: 390, height: 700 });
      for (const how of ['button', 'scrim']) {
        await page.evaluate(() => window.scrollTo(0, 220));
        const y = await page.evaluate(() => window.pageYOffset);
        await page.evaluate(() => document.querySelector('#stack-root [data-stack-sheet^="bill:"]').click());
        await settle(page);
        if (how === 'button') await page.click('[data-stack-sheet-close]');
        else {
          // a point on the scrim itself (the sticky site header can sit over the top of it): scan down from the top
          const at = await page.evaluate(() => { for (let y = 0; y < 300; y++) { const e = document.elementFromPoint(195, y);
            if (e && e.hasAttribute('data-stack-sheet-scrim')) return y; } return -1; });
          ok(at >= 0, 'a point on the scrim outside the sheet can be clicked');
          await page.mouse.click(195, at);
        }
        await settle(page);
        const now = { open: !!(await page.$('.stack-sheet')), y: await page.evaluate(() => window.pageYOffset), want: y,
          pos: await page.evaluate(() => getComputedStyle(document.body).position) };
        ok(!now.open && Math.abs(now.y - y) <= 1 && now.pos !== 'fixed', 'closing with the ' + how + ' restores the page and unlocks it', JSON.stringify(now));
      }
      await page.close();
    }

    console.log('4. MUTANT: without the lock the same scenario fails');
    {
      const { page } = await open(browser, body => {
        assert.ok(body.includes("root.classList.add('stack-sheet-open');"), 'the mutant targets the lock line');
        return body.replace("root.classList.add('stack-sheet-open');", '');
      });
      const r = await scenario(page, 'bill');
      ok(r.scrolled && !r.fixed, 'mutant: the body is not fixed', JSON.stringify(r));
      ok(!(r.pageStillOnScrimWheel && r.pageStillOnSheetWheel), 'mutant: a wheel moves the page behind the sheet', JSON.stringify(r));
      await page.close();
    }
    console.log('\nPASS Stack sheet scroll lock in a browser (' + checks + ')');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
