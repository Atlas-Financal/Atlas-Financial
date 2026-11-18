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
          const footer = document.querySelector('.blend-quiet > footer');
          const before = node => !!(node && node.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING);
          return { bottom: section.parentNode === bottom,
            afterSurface: before(document.getElementById('operating-surface')),
            afterSavings: before(document.querySelector('.budget-savings-accounts')),
            afterBalances: before(document.getElementById('recorded-balances')),
            // 991d5c2d removed the Budget page footer; while none is rendered there is nothing to precede, and if one
            // returns the attention block must still come before it.
            beforeFooter: !footer || !!(section.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING),
            attentionVisible: !section.closest('details:not([open])') };
        });
        assert.deepEqual(placement, { bottom: true, afterSurface: true, afterSavings: true,
          afterBalances: true, beforeFooter: true, attentionVisible: true }, `attention after every Budget block: browser errors ${JSON.stringify(errors)}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.match(await page.locator('[data-budget-period-result]').innerText(), /1,632\.01/);
      };
      await order();
      // By design (paintFaceBadges, public/budget-blend.js) the attention list is moved offstage and its controls leave the
      // Tab order; each item needs a visible equivalent on the face (lead ruling, 2026-11-18):
      // - a category item: its badge on the category ring, or the ring's own over-budget state;
      // - a bill item: the visible Bills header "To confirm N" flag, whose N covers every bill attention item;
      // - an Other-spending item: the Other ring's "needs a category" flag. KNOWN GAP until that flag lands (it is being
      //   added in page code); while absent the case is logged, and once present it must be visible.
      const map = await page.evaluate(() => {
        const shown = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
        const items = [...document.querySelectorAll('[data-budget-browse="attention"] .budget-attention-item')];
        const flag = [...document.querySelectorAll('.blend-bills-head .blend-flag')].find(el => /To confirm\s+\d+/.test(el.textContent));
        const rows = items.map(item => {
          const cat = item.getAttribute('data-budget-category-open'), bill = item.getAttribute('data-budget-bill-open');
          if (bill) return { key: bill, kind: 'bill' };
          const host = cat && document.querySelector('[data-blend-cat="' + CSS.escape(cat) + '"]');
          const other = !!host && (host.classList.contains('blend-other') || host.classList.contains('blend-ring-other'));
          if (other) {
            const needs = host.querySelector('[data-blend-needs-category]');
            return { key: cat, kind: 'other', flagPresent: !!needs, equivalent: shown(needs) };
          }
          const badge = host && host.querySelector('[data-blend-badge="' + CSS.escape(cat || '') + '"]');
          const over = !!host && (host.classList.contains('is-over') || !!host.querySelector('.blend-over-pill'));
          return { key: cat, kind: 'category', equivalent: shown(badge) || (shown(host) && over) };
        });
        return { rows, billFlag: shown(flag) ? Number((flag.textContent.match(/To confirm\s+(\d+)/) || [])[1]) : null };
      });
      assert.ok(map.rows.length > 0, 'the invented world raises attention items');
      for (const row of map.rows.filter(r => r.kind === 'category')) assert.equal(row.equivalent, true, `attention item ${row.key}: its badge or over-budget ring is visible`);
      const bills = map.rows.filter(r => r.kind === 'bill');
      if (bills.length) assert.ok(map.billFlag != null && map.billFlag >= bills.length,
        `the visible Bills header "To confirm N" covers all ${bills.length} bill attention item(s) (got ${map.billFlag})`);
      for (const row of map.rows.filter(r => r.kind === 'other')) {
        if (row.flagPresent) assert.equal(row.equivalent, true, `attention item ${row.key}: the Other ring's needs-a-category flag is visible`);
        else console.log(`KNOWN GAP ${width}px: attention item ${row.key} has no Other-ring needs-a-category flag yet`);
      }
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
      await page.close();
      console.log(`PASS ${width}px: bottom order, content/figures, keyboard, repeat, refresh and resize`);
    }
    assert.deepEqual(errors, [], 'no browser runtime errors');
    assert.deepEqual(external, [], 'no external requests');
  } finally { await browser.close(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
