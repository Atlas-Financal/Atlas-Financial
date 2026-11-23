'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fixture = require('./fixtures/budget-surface-data');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const asOf = '2026-08-20T17:55:00Z';
    const data = fixture.served();
    data.liveOverlay.currentPeriodActuals.lastSuccessfulSyncAt = asOf;
    const assets = path.join(__dirname, '..', 'public');
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://classic.test' || route.request().method() !== 'GET') return route.abort();
      if (url.pathname === '/data.json') return route.fulfill({ json: data });
      if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) {
        return route.fulfill({ json: null });
      }
      if (url.pathname === '/') return route.fulfill({ path: path.join(assets, 'index.html') });
      if (/^\/(?:fonts\/)?[\w.-]+\.(?:js|css|woff2|svg|jpg|png)$/.test(url.pathname)) {
        return route.fulfill({ path: path.join(assets, url.pathname.slice(1)) });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    await page.goto('http://classic.test/?view=classic');
    await page.locator('[data-blend-rings]').waitFor();
    const surface = page.locator('[data-budget-surface]').first();
    const total = await surface.locator('[data-bad-term="balanceAfterDeductions"]').first().evaluate(row => ({
      trust: row.dataset.badTermTrust,
      amount: row.querySelector('[data-bad-term-amount]').textContent.trim(),
    }));
    assert.deepEqual(total, { trust: 'estimated', amount: '$1,632.01' });
    assert.match(await surface.locator('[data-blend-term="balanceAfterDeductions"]').textContent(), /\$1,632\.01/);
    const date = await page.locator('[data-blend-updated]').innerText();
    assert.match(date, /Aug(?:ust)? 20,? 2026.*10:55/i);
    const marks = await surface.evaluate(root => {
      const trustWords = /≈|~\s*\$|\bestimat(?:e|ed|es)\b|\best\./i;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const text = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (trustWords.test(node.textContent)) text.push(node.textContent.trim());
      }
      const attributes = [...root.querySelectorAll('[title],[aria-label],[aria-valuetext]')].flatMap(node =>
        ['title', 'aria-label', 'aria-valuetext'].map(key => node.getAttribute(key) || '').filter(value => trustWords.test(value)));
      const styles = [...root.querySelectorAll('.est,.is-est,.is-estimated,.budget-v3-est,.blend-est,.trust-estimated')].map(n => n.className);
      const generated = [...root.querySelectorAll('*')].flatMap(node => ['::before', '::after']
        .map(pseudo => getComputedStyle(node, pseudo).content).filter(value => trustWords.test(value)));
      return { text, attributes, styles, generated };
    });
    assert.deepEqual(marks, { text: [], attributes: [], styles: [], generated: [] });
    await page.locator('.river[role="slider"]').press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('[data-pay-period-swipe]')?.dataset.selectedPayPeriod === 'next-pay-period');
    const stock = page.locator('[data-operating-question="savings"] .budget-step-value');
    assert.equal((await stock.innerText()).trim(), 'Unavailable', 'the next pay period withholds unpublished savings');

    const result = await page.evaluate(() => {
      const figures = [
        { amount: 23.17, trust: 'calculated' },
        { amount: 23.17, trust: 'estimated' },
        { amount: 23.17, trust: 'unknown' },
        { amount: null, trust: 'unavailable' },
        { amount: 0, trust: 'calculated' },
      ].map(Object.freeze);
      const host = document.body.appendChild(document.createElement('div'));
      host.className = 'budget-surface';
      return [budgetBrowseMoney, budgetV3Money].map(render => figures.map(figure => {
        const cell = document.createElement('div');
        cell.innerHTML = render(figure.amount, figure.trust);
        host.appendChild(cell);
        const style = getComputedStyle(cell.firstElementChild || cell);
        return { published: figure, text: cell.textContent, html: cell.innerHTML,
          ink: [style.color, style.opacity, style.fontStyle, style.fontWeight, style.textDecorationLine] };
      }));
    });
    for (const rows of result) {
      assert.deepEqual(rows.map(row => row.text), ['$23.17', '$23.17', 'Unavailable', 'Unavailable', '$0.00']);
      assert.deepEqual(rows[1].published, { amount: 23.17, trust: 'estimated' });
      assert.deepEqual(rows[0].published, { amount: 23.17, trust: 'calculated' });
      assert.equal(rows[1].html, rows[0].html);
      assert.doesNotMatch(rows[1].html, /≈|~|estimat|calculated|class="est\b/i);
      assert.deepEqual(rows[1].ink, rows[0].ink);
    }
    assert.deepEqual(errors, []);
    console.log('PASS Classic figures keep their amounts and trust, with identical markup and ink. Unknown and withheld amounts read Unavailable.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
