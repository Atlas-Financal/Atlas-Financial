'use strict';
// Owner design "Refined", step 3 (#821): the Budget cards can be moved and
// resized. Display only: the layout is a per-browser preference, no figure
// moves. This proves, through the real page:
//   1. the default order and sizes for phone, tablet and desktop, with the
//      DOM (keyboard / screen-reader) order equal to the visible layout and
//      no sideways scroll on a phone;
//   2. the keyboard path: Edit layout, Move later/earlier and the size
//      buttons, each announced, focus kept, Escape leaves edit mode;
//   3. the layout persists per browser across a reload, under its own key;
//   4. a bad or old saved layout, or refused storage, falls back to the
//      default without a page error;
//   5. reduced motion turns the edit jiggle off;
//   6. the pointer path: touch-and-hold enters edit mode, drag moves a card,
//      the corner grip resizes it.
// CHROME_PATH=<Chromium> node test/browser-budget-board-layout.js
// The fixture (other-period-target) is invented data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/other-period-target');
const root = path.join(__dirname, '..');
const KEY = 'atlas-budget-board-v1';
const SIZES = { balance: 'XL', bills: 'L', house: 'L', cards: 'M', goals: 'L' };

async function open(browser, width, opts = {}) {
  const context = opts.context || await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: opts.motion || 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  if (opts.init) await page.addInitScript(opts.init.fn, opts.init.arg);
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== 'http://budget.test') return route.abort();
    if (u.pathname === '/data.json') return route.fulfill({ json: fx.build(137.26).data });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
    const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ body: fs.readFileSync(file),
      contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('http://budget.test/');
  await page.locator('.blend-board > .blend-w').first().waitFor();
  return { page, context, errors };
}

const state = page => page.evaluate(() => {
  const board = document.querySelector('.blend-board');
  const wraps = [...board.querySelectorAll(':scope > .blend-w')];
  // Visible order: top, then left, of each card.
  const visual = wraps.map(w => ({ id: w.dataset.wId, r: w.getBoundingClientRect() }))
    .sort((a, b) => Math.round(a.r.top) - Math.round(b.r.top) || a.r.left - b.r.left).map(x => x.id);
  return {
    dom: wraps.map(w => w.dataset.wId),
    visual,
    sizes: Object.fromEntries(wraps.map(w => [w.dataset.wId, w.dataset.size])),
    cols: board.dataset.cols,
    editing: board.classList.contains('is-editing'),
    scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    live: document.querySelector('[data-blend-board-live]')?.textContent || '',
    saved: (() => { try { return localStorage.getItem('atlas-budget-board-v1'); } catch (e) { return 'refused'; } })(),
  };
});

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
  try {
    // 1. Defaults per width; DOM order is the visible order.
    for (const [width, cols, order] of [
      [390, '2', ['balance', 'bills', 'house', 'cards', 'goals']],
      [900, '4', ['balance', 'bills', 'house', 'goals', 'cards']],
      [1440, '6', ['balance', 'house', 'bills', 'goals', 'cards']],
    ]) {
      const { page, context, errors } = await open(browser, width);
      const s = await state(page);
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      assert.equal(s.cols, cols, `${width}px: ${cols} columns`);
      assert.deepEqual(s.dom, order, `${width}px: default order in the DOM`);
      assert.deepEqual(s.sizes, SIZES, `${width}px: default sizes`);
      if (width === 390) {
        assert.deepEqual(s.visual, order, '390px: the visible stack follows the DOM order');
        assert.equal(s.scrollX, 0, '390px: no sideways scroll');
      }
      assert.equal(s.editing, false, `${width}px: not editing on load`);
      assert.equal(await page.locator('.blend-w-ctl:visible').count(), 0, `${width}px: no layout controls outside edit mode`);
      await context.close();
    }

    // 2 + 3. Keyboard path, announcements, focus, persistence.
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, reducedMotion: 'reduce' });
      const { page, errors } = await open(browser, 390, { context });
      const edit = page.locator('[data-blend-board-edit]');
      await edit.focus();
      await page.keyboard.press('Enter');
      let s = await state(page);
      assert.equal(s.editing, true, 'Enter on Edit layout enters edit mode');
      assert.equal(await edit.getAttribute('aria-pressed'), 'true', 'Edit layout reports pressed');
      assert.equal(await page.locator('.blend-w[data-w-id="bills"] > [data-budget-browse="bills"]').evaluate(n => n.inert), true,
        'card contents are inert while editing');
      const later = page.locator('.blend-w[data-w-id="bills"] [data-w-move="1"]');
      assert.equal(await later.getAttribute('aria-label'), 'Move Bills later', 'move button has a spoken name');
      await later.focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(120);
      s = await state(page);
      assert.deepEqual(s.dom, ['balance', 'house', 'bills', 'cards', 'goals'], 'Move later swaps Bills after Household in the DOM');
      assert.deepEqual(s.visual, s.dom, 'visible order follows the DOM after a move');
      assert.equal(s.live, 'Bills moved to position 3 of 5.', 'the move is announced');
      assert.equal(await later.evaluate(n => document.activeElement === n), true, 'focus stays on the move button');
      const small = page.locator('.blend-w[data-w-id="goals"] [data-w-size="S"]');
      assert.equal(await small.getAttribute('aria-label'), 'Small', 'size button has a spoken name');
      await small.focus();
      await page.keyboard.press('Space');
      await page.waitForTimeout(120);
      s = await state(page);
      assert.equal(s.sizes.goals, 'S', 'size button resizes the card');
      assert.equal(await small.getAttribute('aria-pressed'), 'true', 'the chosen size reports pressed');
      assert.equal(s.live, 'Savings goals: Small.', 'the resize is announced');
      const first = page.locator('.blend-w[data-w-id="balance"] [data-w-move="-1"]');
      assert.equal(await first.isDisabled(), true, 'the first card cannot move earlier');
      await page.keyboard.press('Escape');
      s = await state(page);
      assert.equal(s.editing, false, 'Escape leaves edit mode');
      assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-blend-board-edit')), true,
        'focus returns to Edit layout');
      const saved = JSON.parse(s.saved);
      assert.deepEqual(saved.narrow.order, ['balance', 'house', 'bills', 'cards', 'goals'], 'the phone order is saved under ' + KEY);
      assert.equal(saved.narrow.sizes.goals, 'S', 'the phone size is saved');
      assert.deepEqual(saved.wide.order, ['balance', 'house', 'bills', 'goals', 'cards'], 'other widths keep their own default');
      await page.reload();
      await page.locator('.blend-board > .blend-w').first().waitFor();
      s = await state(page);
      assert.deepEqual(s.dom, ['balance', 'house', 'bills', 'cards', 'goals'], 'the order persists across a reload');
      assert.equal(s.sizes.goals, 'S', 'the size persists across a reload');
      await page.locator('[data-blend-board-edit]').click();
      await page.locator('[data-blend-board-reset]').click();
      await page.waitForTimeout(120);
      s = await state(page);
      assert.deepEqual(s.dom, ['balance', 'bills', 'house', 'cards', 'goals'], 'Reset restores the default order');
      assert.deepEqual(s.sizes, SIZES, 'Reset restores the default sizes');
      assert.deepEqual(errors, [], 'keyboard path: no page errors');
      await context.close();
    }

    // 2b. Codex review on d64e4ee: packing never pulls a later card ahead of
    // an earlier one, and a touch user can still scroll and reach Done.
    {
      const sizes = { balance: 'XL', bills: 'S', house: 'L', cards: 'M', goals: 'S' };
      const init = { fn: ([key, value]) => { try { localStorage.setItem(key, value); } catch (e) {} },
        arg: [KEY, JSON.stringify({ narrow: { order: ['balance', 'bills', 'house', 'cards', 'goals'], sizes } })] };
      const { page, context, errors } = await open(browser, 390, { init });
      let s = await state(page);
      assert.deepEqual(s.sizes, sizes, 'two small cards on a phone');
      assert.deepEqual(s.visual, s.dom, 'small cards leave a gap rather than pull a later card ahead: ' + s.visual.join(','));
      await page.locator('[data-blend-board-edit]').click();
      const touch = await page.locator('.blend-w[data-w-id="house"]').evaluate(n => getComputedStyle(n).touchAction);
      assert.equal(touch, 'pan-y', 'cards keep vertical touch scrolling while editing');
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(100);
      const done = await page.locator('[data-blend-board-edit]').evaluate(n => {
        const r = n.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
      });
      assert.ok(done.top >= 0 && done.bottom <= done.vh, 'Done stays on screen while editing at the top of the page: ' + JSON.stringify(done));
      assert.deepEqual(errors, [], 'packing and touch exit: no page errors');
      await context.close();
    }

    // 4. Bad, old or refused storage falls back to the default.
    for (const [label, init] of [
      ['unparseable JSON', { fn: key => { try { localStorage.setItem(key, '{not json'); } catch (e) {} }, arg: KEY }],
      ['old shape with an unknown card', { fn: key => { try { localStorage.setItem(key, JSON.stringify({ narrow: { order: ['balance', 'bills', 'house', 'cards', 'goals', 'xfer'], sizes: { balance: 'L' } } })); } catch (e) {} }, arg: KEY }],
      ['duplicate card and bad size', { fn: key => { try { localStorage.setItem(key, JSON.stringify({ narrow: { order: ['bills', 'bills', 'house', 'cards', 'goals'], sizes: { balance: 'XL', bills: 'Huge', house: 'L', cards: 'M', goals: 'L' } } })); } catch (e) {} }, arg: KEY }],
      // Refused for the layout key only: reads and writes of this preference
      // throw (as with a blocked or full store); the rest of the page keeps
      // its own storage.
      ['refused storage', { fn: key => {
        const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
        Storage.prototype.getItem = function (k) { if (k === key) throw new Error('denied'); return get.call(this, k); };
        Storage.prototype.setItem = function (k, v) { if (k === key) throw new Error('denied'); return set.call(this, k, v); };
      }, arg: KEY }],
    ]) {
      const { page, context, errors } = await open(browser, 390, { init });
      let s = await state(page);
      assert.deepEqual(errors, [], `${label}: no page errors`);
      assert.deepEqual(s.dom, ['balance', 'bills', 'house', 'cards', 'goals'], `${label}: default order`);
      assert.deepEqual(s.sizes, SIZES, `${label}: default sizes`);
      if (label === 'refused storage') {
        await page.locator('[data-blend-board-edit]').click();
        await page.locator('.blend-w[data-w-id="bills"] [data-w-move="1"]').click();
        s = await state(page);
        assert.deepEqual(s.dom, ['balance', 'house', 'bills', 'cards', 'goals'], 'refused storage: layout still works for the session');
        assert.deepEqual(errors, [], 'refused storage: saving fails silently');
      }
      await context.close();
    }

    // 5. Reduced motion: no jiggle; full motion: jiggle while editing.
    for (const [motion, jiggles] of [['reduce', false], ['no-preference', true]]) {
      const { page, context } = await open(browser, 1440, { motion });
      await page.locator('[data-blend-board-edit]').click();
      const name = await page.locator('.blend-w[data-w-id="cards"]').evaluate(n => getComputedStyle(n).animationName);
      assert.equal(name !== 'none', jiggles, `${motion}: edit jiggle ${jiggles ? 'on' : 'off'} (${name})`);
      await context.close();
    }

    // 6. Pointer path: hold to edit, drag to move, grip to resize.
    {
      const { page, context, errors } = await open(browser, 1440);
      await page.evaluate(() => window.scrollTo(0, document.querySelector('.blend-board').getBoundingClientRect().top + window.scrollY - 40));
      await page.waitForTimeout(100);
      const box = await page.locator('.blend-w[data-w-id="cards"]').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 60);
      await page.mouse.down();
      await page.waitForTimeout(650);
      let s = await state(page);
      assert.equal(s.editing, true, 'touch and hold enters edit mode');
      const target = await page.locator('.blend-w[data-w-id="house"]').boundingBox();
      await page.mouse.move(box.x + box.width / 2 + 10, box.y + 70, { steps: 3 });
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
      await page.waitForTimeout(250);
      await page.mouse.move(target.x + target.width / 2 + 4, target.y + target.height / 2 + 4, { steps: 2 });
      await page.mouse.up();
      await page.waitForTimeout(200);
      s = await state(page);
      assert.ok(s.dom.indexOf('cards') < s.dom.indexOf('bills'), 'dragging Cards onto Household moves it earlier: ' + s.dom.join(','));
      // Centre the grip: the sticky Done row covers the bottom edge while editing.
      await page.locator('.blend-w[data-w-id="goals"] [data-w-grip]').evaluate(n => n.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(100);
      const grip = await page.locator('.blend-w[data-w-id="goals"] [data-w-grip]').boundingBox();
      const goals = await page.locator('.blend-w[data-w-id="goals"]').boundingBox();
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(grip.x + grip.width / 2 - goals.width * .3, grip.y + grip.height / 2 - goals.height * .7, { steps: 10 });
      await page.mouse.up();
      s = await state(page);
      assert.notEqual(s.sizes.goals, 'L', 'the corner grip resizes the card: ' + s.sizes.goals);
      assert.deepEqual(errors, [], 'pointer path: no page errors');
      await context.close();
    }
    console.log('browser-budget-board-layout: ok');
  } finally {
    await browser.close();
  }
})().catch(err => { console.error(err); process.exit(1); });
