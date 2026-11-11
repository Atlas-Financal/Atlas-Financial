'use strict';
// Finish-line audit finding 13a, page path (#821 6788704527; fixed in #1062).
// A completed pay period older than the provider fetch window has UNKNOWN
// household spending. On the real Budget page, reached the way a person
// reaches it (the Pay period slider, keyboard ArrowLeft), its Household
// budget step must read Unknown / Unavailable and never print a confident
// $0.00. A completed period INSIDE the window keeps its observed amount.
//
// Invented data only (test/fixtures/other-period-target: observed Oct 4,
// fetch window from Sep 10, Other actual 618.73). Every expectation is
// written by hand. `node test/browser-past-period-unknown.js`
// (Playwright browser suite; not part of the node manifest, see test/test.js).
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const fx = require('./fixtures/other-period-target');

const root = path.join(__dirname, '..');
const WINDOW_START = '2026-09-10';

async function household(page) {
  // The visible summary of the Household budget step, and its whole block.
  return page.evaluate(() => {
    const q = document.querySelector('[data-operating-question="06"]');
    const summary = q && q.querySelector(':scope > details > summary');
    const visible = el => !!(el && el.offsetParent);
    return {
      start: document.querySelector('[data-budget-window-progress]')?.dataset.start || null,
      summary: visible(summary) ? summary.innerText.replace(/\s+/g, ' ').trim() : null,
      block: q ? q.textContent.replace(/\s+/g, ' ') : '',
    };
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  try {
    for (const width of [1440, 390]) {
      const f = fx.build(618.73);
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce' });
      const errors = [];
      const external = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.origin !== 'http://budget.test') { external.push(u.origin); return route.abort(); }
        if (u.pathname === '/data.json') return route.fulfill({ json: f.data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
        const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file),
          contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      });
      await page.goto('http://budget.test/');
      await page.locator('.river').waitFor();

      const seen = [];
      for (let i = 0; i < 12; i++) {
        const now = await household(page);
        assert.ok(now.summary, `${width}px ${now.start}: the Household budget step is visible`);
        seen.push(now);
        await page.locator('.river').focus();
        await page.keyboard.press('ArrowLeft');
        const moved = await page.waitForFunction(s => document.querySelector('[data-budget-window-progress]')?.dataset.start !== s,
          now.start, { timeout: 5000 }).then(() => true, () => false);
        if (!moved) break;
      }
      const byStart = new Map(seen.map(s => [s.start, s]));

      // Control: the current period and the completed period inside the window.
      assert.match(byStart.get('2026-09-25')?.summary || '', /\$729\.10[\s\S]*\$925\.00/, `${width}px: current period unchanged`);
      const inWindow = byStart.get('2026-09-11');
      assert.ok(inWindow, `${width}px: the slider reaches the completed period inside the window`);
      assert.match(inWindow.summary, /\$83\.14[\s\S]*Spending observed/, `${width}px: in-window completed period keeps 83.14 observed`);
      assert.doesNotMatch(inWindow.summary, /Actual and plan unknown/, `${width}px: in-window period is not unknown`);

      // Finding 13a: every completed period wholly before the fetch window.
      const older = seen.filter(s => s.start && s.start < WINDOW_START);
      assert.ok(older.length >= 3, `${width}px: the slider steps back past the window (${older.map(s => s.start)})`);
      for (const s of older) {
        assert.match(s.summary, /Unknown[\s\S]*Actual and plan unknown[\s\S]*Unavailable/, `${width}px ${s.start}: Household budget reads Unknown / Unavailable`);
        assert.doesNotMatch(s.block, /\$0\.00/, `${width}px ${s.start}: the Household budget step never prints $0.00`);
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      await page.close();
      console.log(`PASS ${width}px: ${older.length} periods older than the window read Unknown; Sep 11 keeps 83.14; current unchanged`);
    }
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
