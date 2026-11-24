'use strict';
/* Reorderable stacks (Dale, 2026-11-24, lead dispatch) in a real browser at phone width: real App.boot, the real
 * public/ files, invented data only (test/fixtures/budget-surface-data.js served for /data.json by route interception;
 * no server, no household data). A touch phone (hasTouch, isMobile) at 390 wide.
 *
 *   1. Default order: the timeline and the income (waterfall) stack first, then each card in its own slot, in the order
 *      drawn; the screen reader's Move buttons are hidden and out of the Tab order.
 *   2. Press and hold a card, drag it, release: it drops in its new place; the figures printed on the page are unchanged.
 *   3. The order survives a reload (browser storage, per device).
 *   4. The timeline and the income stack cannot be lifted.
 *   5. A tap still opens a card; a swipe still scrolls the page; neither moves anything.
 *   6. The order's storage blocked (every read and write throws) or holding junk: the default order, no page error.
 *   7. Keyboard: Alt+Down / Alt+Up moves the focused card; screen reader: the hidden Move buttons move it and it is
 *      announced.
 *   8. Every card head stays wholly visible and uncovered in a moved order (Credit in the middle).
 *
 * `node test/browser-stack-reorder.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');

const root = path.join(__dirname, '..');
let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

async function newContext(browser, { blockStorage = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  if (blockStorage) {
    // The order's own storage refuses every read and write (as a browser that blocks or fills storage would). Blocking
    // all of localStorage is not used: the page's settlement record (app.js, ATLAS-080) then withholds every figure by
    // design, on main too, so no card would be drawn to order.
    await context.addInitScript(() => {
      const KEY = 'atlas.stackOrder.v1', proto = Storage.prototype;
      const get = proto.getItem, set = proto.setItem;
      proto.getItem = function (k) { if (k === KEY) throw new Error('storage blocked'); return get.call(this, k); };
      proto.setItem = function (k, v) { if (k === KEY) throw new Error('storage blocked'); return set.call(this, k, v); };
    });
  }
  await context.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== 'http://stack.test') return route.abort();
    if (u.pathname === '/data.json') return route.fulfill({ json: fx.served({ mortgageObligation: true }) });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
    const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
  });
  return context;
}
async function open(context) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://stack.test/');
  await page.waitForSelector('#stack-root [data-stack-slot]');
  await page.evaluate(() => document.fonts.ready);
  return { page, errors };
}
const pileOrder = page => page.$$eval('#stack-root [data-stack-pile] > *', els => els
  .filter(e => getComputedStyle(e).display !== 'none')
  .map(e => e.getAttribute('data-stack-slot') || e.getAttribute('data-stack-block') || (e.querySelector('[data-stack-block]') || {}).getAttribute?.('data-stack-block') || '?'));
const slots = page => page.$$eval('#stack-root [data-stack-pile] > [data-stack-slot]', els => els.map(e => e.getAttribute('data-stack-slot')));
// Every printed figure on the page, in document order, sorted: the same set whatever the order.
const figures = page => page.evaluate(() => [...document.querySelectorAll('#stack-root .n, #stack-root .sc-f, #stack-root .sc-a, #stack-root .stack-credit-fig, #stack-root [class*="stack-credit"] .stack-n')]
  .map(e => e.textContent.trim()).filter(Boolean).sort());
const headOf = (page, id) => page.locator(`[data-stack-slot="${id}"] > details > summary, [data-stack-slot="${id}"] [data-stack-credit-toggle]`).first();

// A touch press held for ms, then moved to the target's centre in steps, then released (CDP touch events, as a finger).
async function holdAndDrag(page, from, toY, { holdMs = 650 } = {}) {
  const box = await from.boundingBox();
  const x = box.x + box.width / 2, y = box.y + Math.min(20, box.height / 2);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, py) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: py }] });
  await touch('touchStart', y);
  await page.waitForTimeout(holdMs);
  const steps = 12;
  for (let i = 1; i <= steps; i++) { await touch('touchMove', y + (toY - y) * i / steps); await page.waitForTimeout(16); }
  await touch('touchEnd', toY);
  await page.waitForTimeout(150);
}

(async () => {
  const browser = await chromium.launch();
  try {
    console.log('1. Default order');
    const ctx = await newContext(browser);
    let { page, errors } = await open(ctx);
    const order0 = await slots(page);
    ok(order0.length >= 3 && order0[order0.length - 1] === 'credit' && order0.includes('bills') && order0.includes('budget'),
      'each card and Credit has its own slot, Credit last by default', JSON.stringify(order0));
    const pile0 = await pileOrder(page);
    ok(pile0[0] === 'timeline' && pile0[1] === 'waterfall', 'the timeline and the income stack come first', JSON.stringify(pile0));
    ok(await page.$$eval('[data-stack-move]', els => els.length > 0 && els.every(b => b.tabIndex === -1 && b.getBoundingClientRect().width <= 1)),
      'the Move buttons exist for a screen reader only: hidden, out of the Tab order');
    const figs0 = await figures(page);

    console.log('2. Press, hold and drag');
    // Drag the first card below the last one.
    const first = headOf(page, order0[0]);
    await first.evaluate(el => el.scrollIntoView({ block: 'start' }));
    const lastBox = await headOf(page, order0[order0.length - 1]).boundingBox();
    ok(lastBox.y + lastBox.height + 30 < 844, 'the whole pile of cards is on screen for the drag', JSON.stringify(lastBox));
    await holdAndDrag(page, first, lastBox.y + lastBox.height + 30);
    const order1 = await slots(page);
    ok(order1[order1.length - 1] === order0[0] && order1.length === order0.length,
      `the held ${order0[0]} card dropped last`, JSON.stringify([order0, order1]));
    ok(JSON.stringify(await figures(page)) === JSON.stringify(figs0), 'every printed figure is unchanged by the move');
    {
      // What is kept in the browser: the card names in their order, nothing else (no figure, no label, no date).
      const stored = await page.evaluate(() => localStorage.getItem('atlas.stackOrder.v1'));
      ok(stored === JSON.stringify(order1) && !/\d/.test(stored), 'browser storage holds only the card names in their order', stored);
      ok(await page.evaluate(() => Object.keys(localStorage).filter(k => /stack/i.test(k)).join()) === 'atlas.stackOrder.v1', 'and no other Stack key');
    }
    ok(!(await page.$(`[data-stack-slot="${order0[0]}"] > details[open]`)), 'the long press did not open the card');
    ok(await page.evaluate(() => !document.documentElement.classList.contains('stack-dragging') && !document.querySelector('.is-lifted')),
      'nothing stays lifted after the drop');

    console.log('3. Remembered across a reload');
    await page.reload();
    await page.waitForSelector('#stack-root [data-stack-slot]');
    ok(JSON.stringify(await slots(page)) === JSON.stringify(order1), 'the new order is kept after a reload', JSON.stringify(await slots(page)));

    console.log('4. The timeline and the income stack stay put');
    for (const sel of ['[data-stack-block="timeline"]', '.stack-wf-block']) {
      const el = page.locator(sel).first();
      await el.scrollIntoViewIfNeeded();
      await holdAndDrag(page, el, 800);
      const p = await pileOrder(page);
      ok(p[0] === 'timeline' && p[1] === 'waterfall' && JSON.stringify(await slots(page)) === JSON.stringify(order1),
        `a press and hold on ${sel} lifts nothing and moves nothing`, JSON.stringify(p));
    }
    ok(await page.$$eval('.stack-tl [data-stack-move], .stack-wf-block [data-stack-move]', els => els.length === 0), 'no Move controls on the fixed stacks');

    console.log('5. A tap opens; a swipe scrolls');
    {
      const id = order1[0];
      const head = headOf(page, id);
      await head.scrollIntoViewIfNeeded();
      await head.tap();
      await page.waitForTimeout(150);
      const opened = id === 'credit'
        ? await page.$('[data-stack-credit-toggle][aria-expanded="true"]')
        : await page.$(`[data-stack-slot="${id}"] > details[open]`);
      ok(!!opened, `a tap opens the ${id} card`);
      ok(JSON.stringify(await slots(page)) === JSON.stringify(order1), 'the tap moved nothing');
      await head.tap();
      await page.waitForTimeout(100);
      await page.evaluate(() => window.scrollTo(0, 0));
      const before = await page.evaluate(() => window.scrollY);
      const cdp = await page.context().newCDPSession(page);
      const box = await headOf(page, order1[1]).boundingBox();
      const x = box.x + box.width / 2, y = Math.min(box.y + 10, 800);
      // A quick finger swipe up from the card (no hold): the page scrolls.
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let i = 1; i <= 10; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - i * 30 }] });
        await page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(300);
      ok(await page.evaluate(() => window.scrollY) > before, 'a swipe that starts on a card scrolls the page');
      ok(JSON.stringify(await slots(page)) === JSON.stringify(order1), 'the swipe moved nothing');
    }

    console.log('7. Keyboard and screen reader');
    {
      const id = order1[order1.length - 1];
      const head = headOf(page, id);
      await head.focus();
      await page.keyboard.press('Alt+ArrowUp');
      const k1 = await slots(page);
      ok(k1.indexOf(id) === order1.length - 2, `Alt+Up moves the focused ${id} card up one`, JSON.stringify(k1));
      ok(await page.evaluate(sel => document.activeElement && document.activeElement.closest('[data-stack-slot]')?.getAttribute('data-stack-slot') === sel, id),
        'focus stays on the moved card');
      const live = await page.$eval('[data-stack-order-live]', e => e.textContent);
      ok(/moved up/.test(live) && new RegExp(`${order1.length - 1} of ${order1.length}`).test(live), 'the move is announced', live);
      await page.keyboard.press('Alt+ArrowDown');
      ok(JSON.stringify(await slots(page)) === JSON.stringify(order1), 'Alt+Down moves it back');
      await page.$eval(`[data-stack-slot="${id}"] > [data-stack-move="up"]`, b => b.click());
      const k2 = await slots(page);
      ok(k2.indexOf(id) === order1.length - 2, 'the screen reader\'s hidden Move up moves it', JSON.stringify(k2));
      ok(/moved up/.test(await page.$eval('[data-stack-order-live]', e => e.textContent)), 'and is announced');
    }

    console.log('8. A moved order lays out cleanly (Credit in the middle)');
    {
      await page.evaluate(() => localStorage.setItem('atlas.stackOrder.v1', JSON.stringify(['bills', 'credit', 'budget', 'savings', 'billsacct'])));
      await page.reload();
      await page.waitForSelector('#stack-root [data-stack-slot]');
      const s = await slots(page);
      ok(s.indexOf('credit') === 1 && s[0] === 'bills', 'the saved order is applied', JSON.stringify(s));
      const hidden = await page.evaluate(() => [...document.querySelectorAll('#stack-root [data-stack-slot] > details > summary, #stack-root [data-stack-credit-toggle]')]
        .map(el => {
          el.scrollIntoView({ block: 'center' });
          const r = el.getBoundingClientRect(), cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
          const pts = [[cx, r.top + 4], [cx, r.bottom - 4], [r.left + 6, cy], [r.right - 6, cy], [cx, cy]];
          return { id: el.closest('[data-stack-slot]').getAttribute('data-stack-slot'),
            covered: pts.filter(([x, y]) => { const hit = document.elementFromPoint(x, y); return !hit || !el.contains(hit); }).length };
        }).filter(r => r.covered > 0));
      ok(hidden.length === 0, 'every card head is wholly visible and uncovered', JSON.stringify(hidden));
      ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll');
      ok(errors.length === 0, 'no page errors', errors.join(' | '));
    }
    await ctx.close();

    console.log('6. Storage blocked or junk: the default order');
    {
      const blocked = await newContext(browser, { blockStorage: true });
      const b = await open(blocked);
      ok(JSON.stringify(await slots(b.page)) === JSON.stringify(order0), 'storage blocked: the default order', JSON.stringify(await slots(b.page)));
      const head = headOf(b.page, order0[0]);
      await head.focus();
      await b.page.keyboard.press('Alt+ArrowDown');
      ok((await slots(b.page))[1] === order0[0], 'storage blocked: a move still works for this visit');
      ok(b.errors.length === 0, 'storage blocked: no page errors', b.errors.join(' | '));
      await blocked.close();
      const junk = await newContext(browser);
      await junk.addInitScript(() => { try { localStorage.setItem('atlas.stackOrder.v1', '{not json'); } catch (e) { /* */ } });
      const j = await open(junk);
      ok(JSON.stringify(await slots(j.page)) === JSON.stringify(order0), 'junk in storage: the default order');
      ok(j.errors.length === 0, 'junk in storage: no page errors', j.errors.join(' | '));
      await junk.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\nPASS Stack reorder (${checks})`);
})().catch(e => { console.error(e); process.exitCode = 1; });
