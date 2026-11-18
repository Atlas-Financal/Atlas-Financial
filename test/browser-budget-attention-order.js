'use strict';
// Actual-page order and interaction proof using invented household data only.
// NODE_PATH=<Playwright modules> CHROME_PATH=<Chromium> node test/browser-budget-attention-order.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');
const root = path.join(__dirname, '..');
const screenshots = process.env.ATLAS_BUDGET_SCREENSHOTS_DIR;
if (screenshots) fs.mkdirSync(screenshots, { recursive: true });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const errors = [], external = [];
  const baseRef = process.env.ATLAS_BUDGET_BASE_REF;
  const baseFiles = baseRef && Object.fromEntries(['index.html', 'plan.js'].map(name =>
    [name, execFileSync('git', ['show', `${baseRef}:public/${name}`], { cwd: root })]));
  try {
    for (const width of [1440, 390, 320]) {
      let baseline = false;
      const page = await browser.newPage({ viewport: { width, height: 1000 },
        reducedMotion: 'reduce', colorScheme: 'light' });
      page.on('pageerror', err => errors.push(err.message));
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.origin !== 'http://budget.test') { external.push(u.origin); return route.abort(); }
        if (u.pathname === '/data.json') return route.fulfill({ json: fx.served() });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) {
          return route.fulfill({ json: null });
        }
        const name = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
        const file = path.join(root, 'public', name);
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: baseline && baseFiles[name] || fs.readFileSync(file),
          contentType: file.endsWith('.css') ? 'text/css'
            : file.endsWith('.js') ? 'application/javascript' : 'text/html' });
      });
      const boot = async () => {
        await page.goto('http://budget.test/');
        await page.locator('[data-budget-surface]').waitFor();
        assert.equal(await page.evaluate(() => App.data.meta.title), 'Synthetic Budget surface');
      };
      const content = () => page.evaluate(() => ({
        attention: document.querySelector('[data-budget-browse="attention"]').outerHTML,
        // Compare the whole page's currency publications as a multiset: only order changes.
        money: (document.body.textContent.match(/\$[\d,]+(?:\.\d{2})?/g) || []).sort(),
      }));
      let incumbent;
      if (baseFiles) { baseline = true; await boot(); incumbent = await content(); baseline = false; }
      await boot();
      if (incumbent) assert.deepEqual(await content(), incumbent, 'exact attention markup and figures preserved from named base');
      const order = async () => {
        assert.equal(await page.locator('[data-budget-browse="attention"]').count(), 1);
        const placement = await page.evaluate(() => {
          const section = document.querySelector('[data-budget-browse="attention"]');
          const bottom = document.getElementById('budget-attention-bottom');
          const before = node => !!(node && node.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING);
          return { bottom: section.parentNode === bottom,
            afterSurface: before(document.getElementById('operating-surface')),
            afterSavings: before(document.querySelector('.budget-savings-accounts')),
            afterBalances: before(document.getElementById('recorded-balances')),
            attentionVisible: !section.closest('details:not([open])') };
        });
        assert.deepEqual(placement, { bottom: true, afterSurface: true, afterSavings: true,
          afterBalances: true, attentionVisible: true }, `attention after every Budget block: browser errors ${JSON.stringify(errors)}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.match(await page.locator('[data-budget-period-result]').innerText(), /1,632\.01/);
      };
      await order();
      // By design (paintFaceBadges and retireHiddenTabStops, public/budget-blend.js) the attention list is moved offstage
      // and its controls leave the Tab order; their visible face equivalents are checked by
      // test/test-budget-attention-face-flags.js. Assert that contract here, so the programmatic click below cannot hide
      // a change to it.
      const offstage = await page.evaluate(() => {
        const section = document.querySelector('[data-budget-browse="attention"]');
        const controls = [...section.querySelectorAll('a[href], button, summary, input, select, textarea, [tabindex]')];
        return { offstage: section.classList.contains('blend-offstage'), controls: controls.length > 0,
          retired: controls.every(el => el.getAttribute('tabindex') === '-1') };
      });
      assert.deepEqual(offstage, { offstage: true, controls: true, retired: true },
        'the attention list is offstage and its controls are out of the Tab order, by design');
      // 991d5c2d removed the page footer the old ordering check measured against; it must stay removed, so the
      // attention block (already proved last, in #budget-attention-bottom) has no footer to precede.
      assert.equal(await page.locator('.blend-quiet > footer').count(), 0, 'no page footer is rendered (991d5c2d)');
      const capture = async name => {
        if (!screenshots) return;
        await page.evaluate(async () => { await document.fonts.ready; });
        await page.screenshot({ path: path.join(screenshots, `${name}-${width}.png`), animations: 'disabled' });
      };
      await page.locator('#budget-attention-bottom').scrollIntoViewIfNeeded();
      await capture('attention-bottom');
      const selectors = [
        '[data-budget-category-open="other-spending"][data-budget-browse-origin="attention"]',
        '[data-budget-bill-open="hydro"][data-budget-browse-origin="attention"]',
      ];
      for (const selector of selectors) {
        const trigger = page.locator(selector);
        for (const dismissal of ['Escape', 'close']) {
          await trigger.focus(); await page.keyboard.press('Enter');
          assert.equal(await page.locator('[data-budget-detail-sheet]').evaluate(el => el.open), true);
          assert.equal(await page.locator('[data-budget-detail-body]').isVisible(), true);
          if (dismissal === 'Escape') await page.keyboard.press('Escape');
          else await page.locator('[data-budget-detail-close]').click();
          assert.equal(await trigger.evaluate(el => el === document.activeElement), true, 'exact attention trigger regains focus');
        }
        await trigger.focus();
        await page.evaluate(() => App.rerender());
        assert.equal(await trigger.evaluate(el => el === document.activeElement), true, 'refresh preserves attention focus');
        await page.keyboard.press('Enter');
        await page.evaluate(() => App.rerender());
        assert.equal(await page.locator('[data-budget-detail-sheet]').evaluate(el => el.open), true, 'refresh restores an open attention detail');
        await page.setViewportSize({ width: width === 1440 ? 390 : 1440, height: 1000 });
        await page.setViewportSize({ width, height: 1000 });
        await page.keyboard.press('Escape');
        assert.equal(await trigger.evaluate(el => el === document.activeElement), true, 'resize and refresh preserve dismissal target');
        await order();
      }
      for (let i = 0; i < 3; i++) await page.evaluate(() => App.rerender());
      await order();
      // The offstage control is not a pointer target by design; a programmatic click still opens its detail.
      await page.locator(selectors[0]).evaluate(el => el.click());
      assert.equal(await page.locator('[data-budget-detail-sheet][open]').count(), 1);
      await page.keyboard.press('Escape');
      // The pointer path a person uses: a real click on the visible face equivalent (the Other ring) opens the same
      // Other spending detail.
      await page.locator('[data-blend-cat="other-spending"]').first().click();
      assert.equal(await page.locator('[data-budget-detail-sheet][open]').count(), 1, 'a real click on the Other ring opens its detail');
      assert.match(await page.locator('[data-budget-detail-body]').innerText(), /^\s*Other spending/i, 'the ring opens the Other spending detail');
      await page.keyboard.press('Escape');
      await page.close();
      console.log(`PASS ${width}px: bottom order, content/figures, keyboard, repeat, refresh and resize`);
    }
    assert.deepEqual(errors, [], 'no browser runtime errors');
    assert.deepEqual(external, [], 'no external requests');
  } finally { await browser.close(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
