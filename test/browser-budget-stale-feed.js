'use strict';
// #821 (owner decision 2026-11-08): a stale bank feed must not read as zero
// spending. Real Budget page, real renderers, invented data only.
// Stale: the invented feed's newest spending row (2026-09-25) is nine days
// before its observation (2026-10-04), so the page shows a dated notice and
// marks the current period's spent figures Incomplete, on the source rows,
// the household total and the circles. Fresh: the same feed plus one row
// dated on the observation day shows neither. The expected date is the
// fixture's own literal row date, not read from Forecast.
// NODE_PATH=<Playwright modules> CHROME_PATH=<Chromium> node test/browser-budget-stale-feed.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/other-period-target');
const root = path.join(__dirname, '..');
const NEWEST_STALE_ROW = '2026-09-25'; // fx: every default row is dated the period start

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const errors = [], external = [];
  try {
    const open = async (data, width) => {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce' });
      page.on('pageerror', err => errors.push(err.message));
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.origin !== 'http://budget.test') { external.push(u.origin); return route.abort(); }
        if (u.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
        const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file),
          contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      });
      await page.goto('http://budget.test/');
      await page.locator('[data-budget-surface]').waitFor();
      await page.locator('[data-blend-rings]').waitFor();
      return page;
    };
    const read = page => page.evaluate(() => {
      const section = document.querySelector('[data-budget-browse="spending"]');
      const notice = document.querySelector('[data-bank-feed-stale]');
      const box = notice ? notice.getBoundingClientRect() : null;
      const row = section?.querySelector('[data-budget-category-open="groceries"]');
      const ring = document.querySelector('.blend-ring[data-blend-cat="groceries"]');
      return {
        sectionFeed: section?.getAttribute('data-bank-feed') || null,
        notice: notice ? notice.textContent.replace(/\s+/g, ' ').trim() : null,
        noticeDate: notice?.querySelector('time')?.getAttribute('datetime') || null,
        noticeVisible: !!box && box.width > 0 && box.height > 0,
        noticeNearHousehold: !!notice && !!notice.closest('[data-budget-browse="spending"]'),
        rowTrust: row?.getAttribute('data-budget-spent-trust') || null,
        rowMeta: row?.querySelector('.budget-category-meta')?.textContent.replace(/\s+/g, ' ').trim() || null,
        ringMark: !!ring?.querySelector('[data-blend-spent-incomplete]'),
        ringMarks: document.querySelectorAll('[data-blend-spent-incomplete]').length,
        rings: document.querySelectorAll('.blend-ring').length,
        totalMark: !!document.querySelector('[data-budget-browse-hold] [data-budget-spent-incomplete]'),
        anyIncomplete: document.querySelectorAll('[data-budget-spent-incomplete], [data-blend-spent-incomplete], [data-budget-spent-trust]').length,
      };
    });
    const stale = fx.build(137.26, fx.asOf).data;
    const fresh = fx.build(137.26, fx.asOf, { extraTx: [{ date: fx.asOf, amount: 4.21, categoryLabel: 'Groceries' }] }).data;
    for (const width of [1440, 390]) {
      const s = await read(await open(stale, width));
      assert.equal(s.sectionFeed, 'stale', width + ': stale feed stamps the household section');
      assert.ok(s.notice && s.notice.startsWith('Bank transactions last arrived Sep 25.'), width + ': dated notice: ' + s.notice);
      assert.match(s.notice, /incomplete/i, width + ': notice says the period is incomplete');
      assert.equal(s.noticeDate, NEWEST_STALE_ROW, width + ': notice is dated to the newest imported row');
      assert.ok(s.noticeVisible && s.noticeNearHousehold, width + ': notice is visible in the household budget card');
      assert.equal(s.rowTrust, 'incomplete', width + ': the groceries spent figure is tagged incomplete');
      assert.match(s.rowMeta, /\$110\.37\s*Incomplete/, width + ': the printed spent amount carries the mark: ' + s.rowMeta);
      assert.ok(s.ringMark, width + ': the groceries circle carries the mark');
      assert.ok(s.ringMarks >= 1 && s.ringMarks <= s.rings, width + ': marks only on circles');
      assert.ok(s.totalMark, width + ': the household Actual total carries the mark');
      const f = await read(await open(fresh, width));
      assert.equal(f.sectionFeed, null, width + ': fresh feed: no stale stamp');
      assert.equal(f.notice, null, width + ': fresh feed: no notice');
      assert.equal(f.anyIncomplete, 0, width + ': fresh feed: no incomplete marking anywhere');
      assert.ok(f.rings > 0 && f.rowMeta, width + ': fresh feed still renders the circles and rows');
      console.log('  ok   ' + width + 'px: stale shows the dated notice and Incomplete marks; fresh shows neither');
    }
    assert.deepEqual(errors, [], 'no page errors');
    assert.deepEqual(external, [], 'no external requests');
  } finally { await browser.close(); }
})().catch(err => { console.error(err); process.exit(1); });
