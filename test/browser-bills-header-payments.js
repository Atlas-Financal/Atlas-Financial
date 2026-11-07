'use strict';
const { stepPeriod, openPeriodFigures } = require('./helpers/visible-period-navigation');
// Actual App.boot with invented typed observations. All network intercepted.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const { chromium } = require('playwright');
const fx = require('./fixtures/bills-header-payments-data');
const root = path.join(__dirname, '..');
const out = process.env.ATLAS_BUDGET_SCREENSHOTS_DIR || path.join(require('node:os').tmpdir(), 'bills-header-payments');
fs.mkdirSync(out, { recursive: true });
const executionHead = cp.execFileSync('git', ['-c', 'safe.directory=' + root.replace(/\\/g, '/'), 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const states = [], errors = [], writes = [], external = [];
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  try {
    for (const width of [1440, 390, 320]) for (const state of ['complete', 'pending', 'issuer-unknown', 'coverage-withheld']) {
      const data = fx.served();
      if (state === 'pending') data.plan.obligations[0].sentPayments[0].pending = true;
      if (state === 'issuer-unknown') data.plan.opening.representedEvents = data.plan.opening.representedEvents.filter(r => r.id !== 'invented-minimum-0');
      if (state === 'coverage-withheld') data.liveOverlay.currentPeriodActuals.transactionCoverage = 'truncated';
      const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', colorScheme: 'light' });
      page.setDefaultTimeout(10000);
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.origin !== 'http://bills.test') { external.push(u.origin); return route.abort(); }
        if (route.request().method() !== 'GET') writes.push(route.request().method());
        if (u.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
        const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
        return fs.existsSync(file) ? route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }) : route.fulfill({ status: 404, body: '' });
      });
      await page.goto('http://bills.test/');
      await page.locator('[data-budget-surface]').waitFor();
      assert.equal(await page.evaluate(() => App.data.meta.title), 'Invented Bills header payments');
      const trigger = page.locator('[data-operating-question="04"] > details > summary');
      const text = await trigger.innerText();
      const expected = state === 'pending' ? '250.19' : '317.62';
      if (state === 'coverage-withheld') assert.match(text, /Unknown/);
      else assert.ok(text.includes(expected), text);
      assert.ok(text.includes('269.94'), 'original requirements printed in the header');
      assert.equal(await trigger.locator('[data-budget-progress-partial]').count(), ['pending', 'issuer-unknown'].includes(state) ? 1 : 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no viewport overflow');
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
      await page.screenshot({ path: path.join(out, `${state}-${width}.png`), fullPage: true, animations: 'disabled' });
      await trigger.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('[data-budget-detail-sheet]')?.open);
      const body = page.locator('[data-budget-detail-body]');
      const evidence = await body.locator('[data-budget-progress-evidence="bills"]').innerText();
      if (state === 'coverage-withheld') assert.match(evidence, /Actual: Unavailable/);
      else assert.ok(evidence.includes('Actual: $' + expected));
      assert.match(evidence, /Money sent is separate from lender minimum confirmation/);
      assert.match(await page.locator('#budget-bills-heading').innerText(), state === 'coverage-withheld' ? /Unknown/ : new RegExp(expected.replace('.', '\\.')));
      await page.screenshot({ path: path.join(out, `${state}-info-${width}.png`), animations: 'disabled' });
      await page.keyboard.press('Escape');
      assert.equal(await trigger.evaluate(el => el === document.activeElement), true, 'exact trigger regains keyboard focus');
      const bill = page.locator('[data-budget-browse="bills"] [data-budget-bill-open="invented-minimum-0"]');
      await bill.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('[data-budget-detail-sheet]')?.open);
      const billInfo = await body.innerText();
      if (state === 'complete' || state === 'issuer-unknown') {
        assert.match(billInfo, /Money sent\s+\$67\.43/);
        assert.match(billInfo, /Lender minimum confirmation\s+(Confirmed|Not confirmed)/);
        if (state === 'issuer-unknown') assert.match(billInfo, /Lender minimum confirmation\s+Not confirmed/);
      }
      await page.screenshot({ path: path.join(out, `${state}-minimum-${width}.png`), animations: 'disabled' });
      await page.keyboard.press('Escape');
      assert.equal(await bill.evaluate(el => el === document.activeElement), true, 'exact minimum trigger regains focus');
      if (state === 'complete') {
        for (let repeat = 0; repeat < 2; repeat++) {
          await trigger.focus(); await page.keyboard.press('Enter');
          await page.waitForFunction(() => document.querySelector('[data-budget-detail-sheet]')?.open);
          assert.match(await body.locator('[data-budget-progress-evidence="bills"]').innerText(), /Actual: \$317\.62/);
          await page.keyboard.press('Escape');
        }
        const selected = await page.locator('[data-pay-period-swipe]').getAttribute('data-selected-pay-period');
        await stepPeriod(page, 'ArrowRight');
        await stepPeriod(page, 'ArrowLeft');
        assert.equal(await page.locator('[data-pay-period-swipe]').getAttribute('data-selected-pay-period'), selected);
        await openPeriodFigures(page);
        await page.locator('[aria-label="Budget planning granularity"] [data-budget-granularity="month"]').click();
        await page.locator('[data-budget-month-view]').waitFor();
        await page.locator('[aria-label="Budget planning granularity"] [data-budget-granularity="pay-period"]').click();
        if (await page.locator('[data-budget-drilldown-exit]').count()) await page.locator('[data-budget-drilldown-exit]').click();
        assert.match(await page.locator('[data-operating-question="04"] > details > summary').innerText(), /317\.62[\s\S]*269\.94/);
        await page.setViewportSize({ width: width === 1440 ? 390 : 1440, height: 1000 });
        assert.match(await page.locator('[data-operating-question="04"] > details > summary').innerText(), /317\.62[\s\S]*269\.94/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      states.push({ width, state, header: text.replace(/\s+/g, ' ').trim(), synthetic: true });
      await page.close();
      console.log(`PASS ${width}px ${state}: App.boot, sealed header/Info, keyboard dismissal and truthful evidence`);
    }
    assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(external, []);
    fs.writeFileSync(path.join(out, 'proof.json'), JSON.stringify({ synthetic: true, executionHead,
      browserSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), states }, null, 2) + '\n');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
