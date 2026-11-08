'use strict';
// #824 Bills as a list. Full native Budget/App/Forecast path, invented bills
// only. Optional browser proof (needs Playwright + Chromium):
//   node test/browser-bills-list-view.js
// The Bills card face shows every bill as one row: date, name, amount and the
// status in words. No click is needed to see them. The header summary stays.
// Presentation only: every printed value is checked against the invented
// fixture below, worked out by hand, not against the page's own code.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');
const root = path.join(__dirname, '..');
const output = process.env.BILLS_LIST_PROOF_DIR || path.join(require('node:os').tmpdir(), 'atlas-bills-list');
fs.mkdirSync(output, { recursive: true });

// Invented period Aug 14-27, 2026, household date Aug 20 (see the fixture).
// Base bills: mortgage 1,400 Aug 15 (paid), hydro 120 est. Aug 18 (no
// payment linked, so to confirm), card minimum 60 Aug 22, internet 85 Aug 24.
// Added here: three services on Aug 24 and seven household bills on Aug 26.
function fixture() {
  const data = fx.served();
  for (let i = 0; i < 3; i++) data.plan.bills.push({ id: `synthetic-extra-${i}`, label: `Synthetic service ${i + 1}`,
    frequency: 'monthly', day: 24, amount: 20 + i, confidence: 'confirmed', payingAccount: 'chequing-a' });
  for (let i = 0; i < 7; i++) data.plan.bills.push({ id: `synthetic-roster-${i}`, label: `Synthetic household bill ${i + 1}`,
    frequency: 'monthly', day: 26, amount: 10 + i, confidence: 'confirmed', payingAccount: 'chequing-a' });
  return data;
}
// Expected face, in date order: [id, date label, name, amount, status word].
const expected = [
  ['mortgage', 'Aug 15', 'Mortgage', '$1,400', /^Paid\b/],
  ['hydro', 'Aug 18', 'Hydro', '$120', /^To confirm\b/],
  ['card-minimum', 'Aug 22', 'Synthetic card minimum', '$60', /^(Due|Not paid)\b/],
  ['internet', 'Aug 24', 'Internet', '$85', /^(Due|Not paid)\b/],
  ...[0, 1, 2].map(i => [`synthetic-extra-${i}`, 'Aug 24', `Synthetic service ${i + 1}`, `$${20 + i}`, /^(Due|Not paid)\b/]),
  ...[0, 1, 2, 3, 4, 5, 6].map(i => [`synthetic-roster-${i}`, 'Aug 26', `Synthetic household bill ${i + 1}`, `$${10 + i}`, /^(Due|Not paid)\b/]),
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
  const errors = [], writes = [];
  try {
    for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme,
        reducedMotion: 'reduce', hasTouch: width < 400, isMobile: width < 400 });
      await context.addInitScript(chosen => { try { localStorage.setItem('hfd-theme', chosen); } catch (e) {} }, theme);
      const data = fixture();
      await context.route('**/*', route => {
        if (route.request().method() !== 'GET') writes.push(route.request().method());
        const url = new URL(route.request().url());
        if (url.origin !== 'http://bills.test') return route.abort();
        if (url.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return route.fulfill({ json: null });
        const file = path.join(root, 'public', url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
        if (!file.startsWith(path.join(root, 'public')) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'application/javascript'
          : file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html' });
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(`${width}/${theme}: ${error.message}`));
      const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.goto('http://bills.test');
      const list = page.locator('[data-budget-browse="bills"] [data-blend-bill-list]');
      await list.waitFor(); await settle();
      const tag = `${width}/${theme}`;
      const originalData = await page.evaluate(() => JSON.stringify(App.data));

      // The calendar grid is gone; the list is on the card face, not in a sheet.
      assert.equal(await page.locator('[data-blend-cal], .blend-day, .blend-dow').count(), 0, `${tag}: no calendar grid`);
      assert.equal(await page.locator('[data-budget-detail-sheet][open]').count(), 0, `${tag}: nothing opened`);
      assert.equal(await list.isVisible(), true, `${tag}: list visible without a click`);

      // One row per bill, every bill, in date order, each fully visible.
      const rows = list.locator('[data-blend-bill]');
      assert.equal(await rows.count(), expected.length, `${tag}: one row per bill`);
      const roster = await page.locator('[data-blend-bills-panel] .budget-bill-row').count();
      assert.equal(roster, expected.length, `${tag}: same bills as the detail roster`);
      const printed = await rows.evaluateAll(nodes => nodes.map(node => ({
        id: node.getAttribute('data-blend-bill'),
        when: node.querySelector('[data-blend-bill-when]').innerText.trim(),
        name: node.querySelector('[data-blend-bill-name]').innerText.trim(),
        amount: node.querySelector('[data-blend-bill-amount]').innerText.trim(),
        status: node.querySelector('[data-blend-bill-status]').innerText.trim(),
        visible: [...node.querySelectorAll('[data-blend-bill-when], [data-blend-bill-name], [data-blend-bill-amount], [data-blend-bill-status]')]
          .every(part => { const b = part.getBoundingClientRect(); const s = getComputedStyle(part);
            return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0; }),
      })));
      printed.forEach((row, i) => {
        const [id, when, name, amount, status] = expected[i];
        const date = '2026-08-' + when.slice(4).padStart(2, '0');
        assert.equal(row.id, `${id}:${date}`, `${tag}: row ${i} order`);
        assert.match(row.when, new RegExp('^' + when + '\\b'), `${tag}: ${id} date`);
        assert.equal(row.name, name, `${tag}: ${id} name`);
        assert.ok(row.amount.includes(amount), `${tag}: ${id} amount ${row.amount}`);
        assert.match(row.status, status, `${tag}: ${id} status in words: ${row.status}`);
        assert.equal(row.visible, true, `${tag}: ${id} all four parts visible`);
      });
      // The estimated hydro amount keeps its estimate mark from the roster.
      assert.match(printed[1].amount, /≈|est/i, `${tag}: estimate mark kept`);

      // Status is in words and also carried by the row state for colour.
      assert.equal(await rows.nth(0).getAttribute('data-s'), 'paid');
      assert.equal(await rows.nth(1).getAttribute('data-s'), 'confirm');
      const dotColours = await Promise.all([0, 1].map(i => rows.nth(i).locator('.blend-bill-dot').evaluate(n => getComputedStyle(n).backgroundColor)));
      assert.notEqual(dotColours[0], dotColours[1], `${tag}: paid and to-confirm dots differ`);

      // The header summary stays: title, to-confirm count, and (where the
      // layout has room for it) the amount left of total.
      const head = page.locator('[data-budget-browse="bills"] .blend-bills-head');
      assert.equal(await head.locator('[data-blend-bills-open]').isVisible(), true);
      assert.match(await head.locator('.blend-flag').innerText(), /^To confirm 1$/);
      const summary = head.locator('.blend-bills-of');
      assert.equal(await summary.count(), 1, `${tag}: header summary present`);
      assert.match(await summary.textContent(), /\$[\d,.]+ left of \$[\d,.]+/);
      if (width >= 760) assert.equal(await summary.isVisible(), true, `${tag}: header summary visible`);

      // No horizontal page overflow and each row fits its card.
      const fit = await page.evaluate(() => {
        const card = document.querySelector('[data-budget-browse="bills"]').getBoundingClientRect();
        const rows = [...document.querySelectorAll('[data-blend-bill-list] [data-blend-bill]')].map(n => n.getBoundingClientRect());
        return { page: document.documentElement.scrollWidth <= window.innerWidth + 1,
          rows: rows.every(r => r.left >= card.left - 1 && r.right <= card.right + 1), minHeight: Math.min(...rows.map(r => r.height)) };
      });
      assert.equal(fit.page, true, `${tag}: no horizontal page scroll`);
      assert.equal(fit.rows, true, `${tag}: rows fit the card`);
      assert.ok(fit.minHeight >= 44, `${tag}: rows are 44px touch targets`);

      // A row opens that one bill's existing detail; Escape returns focus.
      const hydro = list.locator('[data-blend-bill="hydro:2026-08-18"]');
      await hydro.focus(); await page.keyboard.press('Enter'); await settle();
      const detail = page.locator('[data-budget-detail-sheet][open] [data-period-bill="hydro"]');
      assert.equal(await detail.count(), 1, `${tag}: row opens its bill detail`);
      assert.equal(await detail.getAttribute('data-bill-date'), '2026-08-18');
      await page.keyboard.press('Escape'); await settle(); await settle();
      assert.equal(await page.locator('[data-budget-detail-sheet][open]').count(), 0);
      assert.equal(await hydro.evaluate(el => document.activeElement === el), true, `${tag}: focus back on the row`);
      assert.equal(await hydro.getAttribute('aria-expanded'), 'false');

      // A same-period rerender rebuilds one list, not two.
      await page.evaluate(() => App.rerender()); await settle();
      assert.equal(await page.locator('[data-blend-bill-list]').count(), 1);
      assert.equal(await page.locator('[data-blend-bill-list] [data-blend-bill]').count(), expected.length);

      assert.equal(await page.evaluate(() => JSON.stringify(App.data)), originalData, `${tag}: no data change`);
      await page.locator('[data-budget-browse="bills"]').screenshot({ path: path.join(output, `bills-list-${width}-${theme}.png`), style: '.sitenav-household { visibility:hidden !important; }' });
      await context.close();
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, [], 'GET only');
    console.log(`Bills list browser proof passed (${output})`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
