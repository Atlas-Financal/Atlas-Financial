'use strict';
// Owner design "Refined", step 4 (#821): the Budget pop-up pours out of the
// card that opened it (genie) and back into it on close. Decoration only.
// This proves, through the real page and the real dialog controller:
//   1. open state and focus are immediate: the dialog is [open] and focus is
//      inside it on the same task as the click, while the genie runs;
//   2. the pouring shape is empty strips: no text, no element with an id,
//      no button/link/input, no amount; aria-hidden and inert;
//   3. it cleans up: the strips are gone when the motion ends, a reopen or a
//      second close cancels a running genie at once;
//   4. close pours back into the opener and focus returns to the opener;
//   5. reduced motion: no genie strips, no dialog fade (open is plain).
// CHROME_PATH=<Chromium> node test/browser-budget-sheet-genie.js
// The fixture (other-period-target) is invented data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/other-period-target');
const root = path.join(__dirname, '..');

async function open(browser, width, motion) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: motion });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
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
  await page.locator('[data-blend-rings]').waitFor();
  await page.waitForTimeout(400);
  return { page, context, errors };
}

// Click the first ring and read everything on the same task as the click.
const clickRing = page => page.evaluate(() => {
  const ring = document.querySelector('.blend-ring');
  ring.scrollIntoView({ block: 'center' });
  ring.click();
  const dialog = document.querySelector('[data-budget-detail-sheet]');
  const genie = [...document.querySelectorAll('.budget-sheet-genie')];
  const strips = genie.flatMap(g => [...g.children]);
  return {
    open: dialog.open,
    focusInside: dialog.contains(document.activeElement),
    genies: genie.length,
    strips: strips.length,
    text: genie.map(g => g.textContent).join(''),
    ids: genie.reduce((n, g) => n + g.querySelectorAll('[id]').length + (g.id ? 1 : 0), 0),
    controls: genie.reduce((n, g) => n + g.querySelectorAll('button, a, input, select, summary, [tabindex]').length, 0),
    hidden: genie.every(g => g.getAttribute('aria-hidden') === 'true' && g.inert === true),
    stripsEmpty: strips.every(s => s.childElementCount === 0 && s.textContent === ''),
    dialogFading: dialog.getAnimations().some(a => a.playState === 'running'),
  };
});
const shells = page => page.evaluate(() => document.querySelectorAll('.budget-sheet-motion-shell').length);
const settle = page => page.waitForFunction(() => !document.querySelector('.budget-sheet-motion-shell'), undefined, { timeout: 4000 });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
  try {
    for (const width of [1440, 390]) {
      // 1-4 with motion on.
      {
        const { page, context, errors } = await open(browser, width, 'no-preference');
        const o = await clickRing(page);
        assert.equal(o.open, true, `${width}px: the dialog is open on the click's own task`);
        assert.equal(o.focusInside, true, `${width}px: focus is inside the dialog at once`);
        assert.equal(o.genies, 1, `${width}px: one genie runs on open`);
        assert.ok(o.strips >= 10, `${width}px: the genie is made of strips (${o.strips})`);
        assert.equal(o.text, '', `${width}px: the strips carry no text, so no amount is duplicated`);
        assert.equal(o.ids, 0, `${width}px: no element with an id is duplicated`);
        assert.equal(o.controls, 0, `${width}px: no control is duplicated`);
        assert.equal(o.hidden, true, `${width}px: the genie is aria-hidden and inert`);
        assert.equal(o.stripsEmpty, true, `${width}px: every strip is an empty shape`);
        assert.equal(o.dialogFading, true, `${width}px: the real dialog fades in over the strips`);
        await settle(page);
        assert.equal(await shells(page), 0, `${width}px: the strips are removed when the motion ends`);
        assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-budget-detail-sheet]')).opacity), '1',
          `${width}px: the dialog ends fully visible`);
        // Close pours back; focus returns to the opener.
        const c = await page.evaluate(() => {
          document.querySelector('[data-budget-detail-close]').click();
          const dialog = document.querySelector('[data-budget-detail-sheet]');
          const genie = [...document.querySelectorAll('.budget-sheet-genie')];
          return { closed: !dialog.open, genies: genie.length, text: genie.map(g => g.textContent).join(''),
            focusRing: !!document.activeElement?.closest('.blend-ring, [data-budget-browse="spending"]') };
        });
        assert.equal(c.closed, true, `${width}px: close is immediate`);
        assert.equal(c.genies, 1, `${width}px: the close pours back into the card`);
        assert.equal(c.text, '', `${width}px: the closing strips carry no text`);
        assert.equal(c.focusRing, true, `${width}px: focus returns to the opener`);
        // Reopen during the closing genie cancels it at once.
        const r = await page.evaluate(() => {
          document.querySelector('.blend-ring').click();
          return document.querySelectorAll('.budget-sheet-genie').length;
        });
        assert.equal(r, 1, `${width}px: reopening replaces the closing genie (one genie, not two)`);
        // A second close during the opening genie leaves no strips behind.
        const twice = await page.evaluate(() => {
          const close = document.querySelector('[data-budget-detail-close]');
          close.click(); close.click();
          return document.querySelectorAll('.budget-sheet-motion-shell').length;
        });
        assert.equal(twice, 0, `${width}px: a second close cancels the decorative departure`);
        assert.deepEqual(errors, [], `${width}px motion: no page errors`);
        await context.close();
      }
      // 5. Reduced motion: plain open and close.
      {
        const { page, context, errors } = await open(browser, width, 'reduce');
        const o = await clickRing(page);
        assert.equal(o.open, true, `${width}px reduced: open`);
        assert.equal(o.focusInside, true, `${width}px reduced: focus inside`);
        assert.equal(o.genies, 0, `${width}px reduced: no genie`);
        assert.equal(o.dialogFading, false, `${width}px reduced: no dialog fade`);
        const closed = await page.evaluate(() => {
          document.querySelector('[data-budget-detail-close]').click();
          return { open: document.querySelector('[data-budget-detail-sheet]').open, genies: document.querySelectorAll('.budget-sheet-genie').length };
        });
        assert.deepEqual(closed, { open: false, genies: 0 }, `${width}px reduced: plain close`);
        assert.deepEqual(errors, [], `${width}px reduced: no page errors`);
        await context.close();
      }
    }
    console.log('browser-budget-sheet-genie: ok');
  } finally {
    await browser.close();
  }
})().catch(err => { console.error(err); process.exit(1); });
