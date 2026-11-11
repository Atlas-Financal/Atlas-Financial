'use strict';
/* The Budget card board is fixed again (owner decision, Dale, 2026-11-11).
 * `node test/browser-budget-fixed-board.js`  (CHROME_PATH=<Chromium> optional)
 *
 * The movable/resizable card board (#1057) and the genie pop-up (#1069) are
 * removed. The page goes back to the two fixed columns the board replaced:
 * Balance After Deductions, Bills and Credit cards on the left; Household
 * budget and Savings goals on the right; one stack on a phone. The tile
 * improvements made elsewhere are unchanged.
 *
 * Through the real page, at 1440px (desktop), 1024px (tablet) and 390px
 * (phone), this proves:
 *   1. no widget machinery: no Edit layout or Reset control, no "rearrange
 *      or resize" hint, no layout bars or grips, no .blend-w wrappers, and
 *      every card is a direct member of the fixed columns (or of the phone
 *      stack);
 *   2. an old saved layout is cleared: a browser holding
 *      `atlas-budget-board-v1` loses it on load, and the page never writes
 *      it back;
 *   3. no dead gap between cards: from each card's bottom edge to the next
 *      card below it in the same column is exactly the board's gap
 *      (within 2px). Dale's report was empty bands between cards in a row
 *      of the board; the fixed columns have none;
 *   4. no genie: opening and closing a pop-up with motion allowed creates
 *      no .budget-sheet-genie strips, and the pop-up still opens and closes.
 *
 * Invented fixture only (test/fixtures/budget-surface-data.js). Nothing
 * rendered is printed: failures name the card and width, with pixel
 * distances only.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');

const root = path.join(__dirname, '..');
const KEY = 'atlas-budget-board-v1';
const GAP_TOLERANCE = 2;
const CARDS = {
  balance: '.budget-blend-hero-layout',
  bills: '[data-budget-browse="bills"]',
  house: '[data-budget-browse="spending"]',
  cards: '.budget-blend-card-movements',
  goals: '[data-budget-savings-goals]',
};
const WIDTHS = [1440, 1024, 390];

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

async function open(browser, width) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  // A saved layout from the removed board, and the rings view (whose rings
  // open a pop-up) chosen the way the household's browser would hold them.
  await page.addInitScript(key => {
    try {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem(key, JSON.stringify({ wide: { order: ['goals', 'cards', 'house', 'bills', 'balance'],
          sizes: { balance: 'S', bills: 'S', house: 'S', cards: 'S', goals: 'S' } } }));
        sessionStorage.setItem('seeded', '1');
      }
      localStorage.setItem('atlas-house-view', 'rings');
      const set = Storage.prototype.setItem;
      window.__boardWrites = 0;
      Storage.prototype.setItem = function (k, v) { if (k === key) window.__boardWrites++; return set.call(this, k, v); };
    } catch (e) { /* storage unavailable */ }
  }, KEY);
  const data = fx.served({});
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== 'http://budget.test') return route.abort();
    if (u.pathname === '/data.json') return route.fulfill({ json: data });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
    const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript'
      : file.endsWith('.png') ? 'image/png' : file.endsWith('.woff2') ? 'font/woff2'
      : file.endsWith('.woff') ? 'font/woff' : 'text/html';
    return route.fulfill({ body: fs.readFileSync(file), contentType: type });
  });
  await page.goto('http://budget.test/');
  await page.locator('[data-budget-surface]').waitFor();
  await page.locator('.blend-board').waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  return { page, context, errors };
}

(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  try {
    for (const width of WIDTHS) {
      console.log(`\n=== ${width}px ===`);
      const { page, context, errors } = await open(browser, width);
      const facts = await page.evaluate(({ CARDS, KEY }) => {
        const board = document.querySelector('.blend-board');
        const style = getComputedStyle(board);
        const cols = [...board.querySelectorAll(':scope > .blend-col')];
        const colGap = cols.length && getComputedStyle(cols[0]).display !== 'contents'
          ? parseFloat(getComputedStyle(cols[0]).rowGap) || 0 : parseFloat(style.rowGap) || 0;
        const boxes = Object.entries(CARDS).map(([id, sel]) => {
          const el = document.querySelector(sel);
          if (!el) return { id, missing: true };
          const r = el.getBoundingClientRect();
          const parent = el.parentElement;
          return { id, left: r.left, right: r.right, top: r.top, bottom: r.bottom,
            home: parent === board ? 'board' : parent.classList.contains('blend-col-main') ? 'main'
              : parent.classList.contains('blend-col-side') ? 'side' : 'other' };
        });
        let stored = 'refused';
        try { stored = localStorage.getItem(KEY); } catch (e) { /* refused */ }
        return {
          gap: colGap,
          boxes,
          widgets: document.querySelectorAll('.blend-w, .blend-w-ctl, .blend-w-bar, .blend-w-grip, [data-blend-board-edit], [data-blend-board-reset], [data-w-id], [data-w-size], [data-w-move]').length,
          hint: /rearrange or resize|edit layout/i.test(board.parentElement.innerText),
          editing: board.classList.contains('is-editing'),
          stored,
          writes: window.__boardWrites,
        };
      }, { CARDS, KEY });

      ok(facts.boxes.every(b => !b.missing), 'all five cards render', facts.boxes.filter(b => b.missing).map(b => b.id).join(', '));
      ok(facts.widgets === 0, 'no widget controls or wrappers on the page', String(facts.widgets));
      ok(!facts.hint, 'no "rearrange or resize" or "Edit layout" text');
      ok(!facts.editing, 'the board has no edit mode');
      ok(facts.stored === null, 'an old saved board layout is cleared on load', String(facts.stored === null ? 'cleared' : 'still stored'));
      ok(facts.writes === 0, 'the page never writes the board layout key', String(facts.writes));

      const homes = Object.fromEntries(facts.boxes.map(b => [b.id, b.home]));
      if (width >= 760) {
        ok(homes.balance === 'main' && homes.bills === 'main' && homes.cards === 'main',
          'Balance After Deductions, Bills and Credit cards sit in the main column', JSON.stringify(homes));
        ok(homes.house === 'side' && homes.goals === 'side', 'Household budget and Savings goals sit in the side column', JSON.stringify(homes));
      } else {
        const order = facts.boxes.filter(b => !b.missing).sort((a, b) => a.top - b.top).map(b => b.id).join(',');
        ok(order === 'balance,bills,house,cards,goals', 'the phone stack reads balance, bills, household, cards, goals', order);
      }

      for (const a of facts.boxes.filter(b => !b.missing)) {
        const below = facts.boxes.filter(c => !c.missing && c !== a && c.top >= a.bottom - 1 && c.left < a.right - 1 && c.right > a.left + 1)
          .sort((x, y) => x.top - y.top)[0];
        if (!below) continue;
        const dead = Math.round(below.top - a.bottom - facts.gap);
        ok(Math.abs(dead) <= GAP_TOLERANCE, `no dead gap between ${a.id} and ${below.id}`, `${dead}px beyond the ${facts.gap}px gap`);
      }

      // No genie: watch for its strips while a pop-up opens and closes.
      const ring = page.locator('.blend-ring').first();
      if (await ring.count()) {
        await page.evaluate(() => {
          window.__genie = 0;
          new MutationObserver(records => {
            for (const r of records) for (const n of r.addedNodes) {
              if (n.nodeType === 1 && (n.matches('.budget-sheet-genie') || n.querySelector('.budget-sheet-genie'))) window.__genie++;
            }
          }).observe(document.body, { childList: true, subtree: true });
        });
        await ring.scrollIntoViewIfNeeded();
        await ring.click();
        await page.waitForTimeout(250);
        const opened = await page.evaluate(() => !!document.querySelector('dialog[open]'));
        await page.evaluate(() => document.querySelector('[data-budget-detail-close]')?.click());
        await page.waitForTimeout(600);
        const after = await page.evaluate(() => ({ genie: window.__genie, open: !!document.querySelector('dialog[open]') }));
        ok(opened, 'a pop-up still opens from its card');
        ok(!after.open, 'and closes');
        ok(after.genie === 0, 'no genie strips while it opens and closes', String(after.genie));
      } else {
        ok(false, 'a ring is present to open a pop-up');
      }
      ok(errors.length === 0, 'no page errors', errors.length ? String(errors.length) : '');
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\n${checks} checks, ${failures} failed`);
  if (failures) process.exit(1);
  console.log('The Budget card board is fixed: no widgets, no genie, no dead gaps.');
})().catch(err => { console.error(err); process.exit(1); });
