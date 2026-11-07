'use strict';
// Actual App.boot and Forecast pipeline with intercepted invented HTTP data.
// No production authentication, provider requests or household data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fixture = require('./fixtures/savings-contribution-display-data');
const root = path.join(__dirname, '..');
const before = process.argv.includes('--before');
const screenshots = process.env.ATLAS_SAVINGS_SCREENSHOTS_DIR
  || path.join(require('node:os').tmpdir(), 'atlas-savings-contribution-display');
fs.mkdirSync(screenshots, { recursive: true });
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const errors = [], external = [];
  try {
    for (const width of [1440, 390, 320]) {
      let data = fixture();
      const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://savings.test') { external.push(url.origin); return route.abort(); }
        if (url.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return route.fulfill({ json: null });
        const file = path.join(root, 'public', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.css')
          ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'text/html' });
      });
      const boot = async () => {
        await page.goto('http://savings.test/');
        await page.locator('[data-budget-savings-goals]').waitFor();
        assert.equal(await page.evaluate(() => App.data.meta.title), 'Synthetic savings contribution display');
      };
      const screenshot = async name => {
        await page.evaluate(async () => { await document.fonts.ready; });
        await page.locator('[data-budget-savings-goals]').screenshot({
          path: path.join(screenshots, `${name}-${width}.png`), animations: 'disabled',
          style: '.sitenav-household { visibility:hidden !important; }',
        });
      };
      await boot();
      const goals = page.locator('[data-budget-savings-goals]');
      const course = page.locator('[data-budget-goal-open="garden-course"]');
      // Reviewed #513 publishes current Saved / Needed / this period. This
      // fixture has no verified Savings observation or allocation evidence;
      // the earlier planning requirement (875 - 590 = 285) is not backing.
      // Its independent positive oracle remains in the retained evidence below.
      assert.match(await course.innerText(), /Saved[\s\S]*Needed/);
      assert.match(await course.locator('.budget-goal-context').innerText(), /Unavailable[\s\S]*this period/);
      if (!before) {
        assert.equal(await course.locator('.budget-goal-amount').nth(0).innerText(), 'Unavailable');
        assert.equal(await course.locator('.budget-goal-amount').nth(1).innerText(), 'Unavailable');
        assert.equal(await course.locator('[data-budget-goal-fulfilled], [data-budget-goal-required]').count(), 0,
          'current allocation consumer does not claim period fulfillment');
        assert.equal(await page.locator('[data-budget-goal-open="reading-nook"] .budget-goal-amount').nth(1).innerText(), 'Unavailable');
        assert.equal(await goals.locator('input[type="checkbox"]').count(), 0);
      }
      await screenshot(before ? 'before' : 'required-unknown-actual');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const overflow = await goals.locator('li > button').evaluateAll(rows => rows.filter(row => row.scrollWidth > row.clientWidth + 1).map(row => row.textContent));
      assert.deepEqual(overflow, [], `${width}px savings rows fit`);
      if (!before) {
        await course.focus(); await page.keyboard.press('Tab');
        assert.equal(await page.locator('[data-budget-goal-open="reading-nook"]').evaluate(node => node === document.activeElement), true, 'each row is Tab reachable');
        await page.keyboard.press('Shift+Tab');
        assert.equal(await course.evaluate(node => node === document.activeElement), true);
        await page.locator('[data-operating-question="savings"] [data-budget-goal-fulfillment-evidence="garden-course"]').evaluate(node => { window.__goalEvidence = node; });
        await course.focus(); await page.keyboard.press('Enter');
        const evidence = page.locator('[data-budget-detail-body] [data-budget-goal-fulfillment-evidence="garden-course"]');
        assert.equal(await page.locator('[data-budget-detail-body] [data-budget-goal-fulfillment-evidence]').count(), 1, 'one selected goal, not the entire roster');
        assert.equal(await evidence.evaluate(node => node === window.__goalEvidence), true, 'move incumbent evidence without cloning');
        assert.match(await evidence.innerText(), /Aug 14[\s\S]*Aug 27[\s\S]*current Forecast requirement, not an original payday snapshot/);
        assert.match(await evidence.innerText(), /Required this period:[\s\S]*285\.00[\s\S]*Confirmed fulfilled this period: Unavailable/);
        assert.equal(await page.locator('[data-budget-detail-sheet]').evaluate(node => node.open), true);
        await page.locator('[data-budget-detail-sheet]').screenshot({ path: path.join(screenshots, `goal-evidence-${width}.png`), animations: 'disabled' });
        await page.keyboard.press('Escape');
        assert.equal(await course.evaluate(node => node === document.activeElement), true, 'evidence restores exact row focus');
        assert.equal(await page.locator('[data-operating-question="savings"] [data-budget-goal-fulfillment-evidence="garden-course"]').count(), 1, 'original goal evidence restored');
        assert.equal(await page.locator('[data-operating-question="savings"] [data-budget-goal-fulfillment-evidence="garden-course"]').evaluate(node => node === window.__goalEvidence), true);
        const visibleFocus = await course.evaluate(node => {
          const bounds = node.getBoundingClientRect(), dock = document.querySelector('.sitenav-household');
          const limit = dock && getComputedStyle(dock).position === 'fixed' ? dock.getBoundingClientRect().top : innerHeight;
          return bounds.top >= 0 && bounds.bottom <= limit;
        });
        assert.equal(visibleFocus, true, 'returned row focus stays visible above dock');
        const inventory = page.locator('[data-budget-funding-inventory]');
        await inventory.focus(); await page.keyboard.press('Enter');
        assert.equal(await page.locator('[data-budget-detail-sheet]').evaluate(node => node.open), true);
        await page.keyboard.press('Escape');
        assert.equal(await inventory.evaluate(node => node === document.activeElement), true);
        // Configured accounts with no assignments remain unconfirmed.
        data.plan.savingsEarmarks = { version: 1, currency: 'CAD', pools: [
          { id: 'reserve', accountId: 'savings', label: 'Synthetic reserve' },
        ], history: [] };
        await boot();
        assert.equal(await course.locator('.budget-goal-amount').nth(1).innerText(), 'Unavailable');
        assert.equal(await course.locator('.budget-goal-amount').nth(0).innerText(), 'Unavailable');
        assert.match(await course.locator('.budget-goal-context').innerText(), /Unavailable[\s\S]*this period/);
        assert.doesNotMatch(await goals.innerText(), /Funded|Still to fund/);
        await screenshot('unconfirmed-assignments');
      }
      await page.close();
    }
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(`PASS ${before ? 'before capture' : 'actual App.boot savings rows, required/unknown actual, evidence/focus and unconfirmed assignments'}: desktop, 390px, 320px`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
