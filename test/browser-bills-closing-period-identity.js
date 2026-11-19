'use strict';
// The Expected Bills balance at period end card is Forecast's ACTIVE-period
// publication (docs/proof/BILLS_PERIOD_END_BALANCE.md: rendered on the active
// pay-period Budget view). Its label and value must never ride into another
// selected period's figures: with any non-current period selected the card is
// absent, and it returns unchanged when the current period is reselected.
//
// Real App.boot, invented provider packet, all network intercepted. The
// fixture household is shifted +56 days (a whole number of weeks, so payday
// weekday alignment is preserved) onto the reported calendar: active period
// Oct 9-22, 2026, household date Oct 15, a past period Sep 25-Oct 8 and
// future periods through Dec 18-31 selectable by the window steps.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const { chromium } = require('playwright');
const fx = require('./fixtures/bills-period-end-balance-data');
const root = path.join(__dirname, '..');
const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const SHIFT_DAYS = 56;
function shiftDateString(value) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/);
  if (!match) return value;
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  date.setUTCDate(date.getUTCDate() + SHIFT_DAYS);
  return date.toISOString().slice(0, 10) + match[4];
}
function deepShift(value) {
  if (typeof value === 'string') return shiftDateString(value);
  if (Array.isArray(value)) return value.map(deepShift);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = deepShift(value[key]);
    return out;
  }
  return value;
}
const cards = page => page.evaluate(() => document.querySelectorAll('[data-bills-closing]').length);
const amountText = page => page.evaluate(() =>
  (document.querySelector('[data-bills-closing-amount]')?.textContent || '').replace(/\s+/g, ' ').trim());
const cardText = page => page.evaluate(() =>
  (document.querySelector('[data-bills-closing]')?.textContent || '').replace(/\s+/g, ' ').trim());
const range = page => page.evaluate(() =>
  (document.querySelector('[data-budget-window-range]')?.textContent || '').replace(/\s+/g, ' ').trim());
async function step(page, direction, times) {
  // The river keyboard path, as in test/browser-budget-blend-proof.js.
  for (let i = 0; i < times; i++) {
    const before = await range(page);
    await page.locator('.river').focus();
    await page.keyboard.press(direction < 0 ? 'ArrowLeft' : 'ArrowRight');
    await page.waitForFunction(prev =>
      (document.querySelector('[data-budget-window-range]')?.textContent || '') !== prev, before);
    await page.waitForTimeout(300);
  }
}
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const states = [];
  try {
    for (const variant of ['ready', 'unavailable']) {
      const data = deepShift(fx.served());
      if (variant === 'unavailable') data.plan.cardPurchaseCoverage.opening.confirmed = false;
      const expectedAmount = variant === 'ready' ? 'Estimated $1,092.18' : 'Unavailable';
      const page = await browser.newPage({ viewport: { width: 390, height: 1000 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(15000);
      const errors = [], external = [], writes = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.origin !== 'http://closing.test') { external.push(u.origin); return route.abort(); }
        if (route.request().method() !== 'GET') writes.push(route.request().method());
        if (u.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
        const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
        return fs.existsSync(file) ? route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }) : route.fulfill({ status: 404, body: '' });
      });
      await page.goto('http://closing.test/?view=classic');
      await page.locator('[data-bills-closing]').waitFor({ state: 'attached' });
      await page.waitForTimeout(1500);

      // Current period selected: the card is present and its label names the
      // selected period's own end.
      assert.equal(await range(page), 'Oct 9 – Oct 22', variant + ': starts on the current period');
      assert.equal(await cards(page), 1, variant + ': card present on its own period');
      assert.equal(await amountText(page), expectedAmount, variant + ': current-period amount');
      assert.match(await cardText(page), /through October 22/, variant + ': label names the selected period end');

      // Future period selected: the active-period card must not follow.
      await step(page, 1, 5);
      assert.equal(await range(page), 'Dec 18 – Dec 31', variant + ': future period selected');
      assert.equal(await cards(page), 0, variant + ': no Bills-closing card on a future period');

      // Opening the selected period's figures must not surface it either.
      const trigger = page.locator('[data-operating-question="07"] .budget-step-summary').first();
      await trigger.focus();
      await page.keyboard.press('Enter');
      const dialog = page.locator('dialog[data-budget-detail-sheet][open]');
      await dialog.waitFor();
      assert.equal(await dialog.locator('[data-bills-closing]').count(), 0,
        variant + ': selected-period figures contain no Bills-closing card');
      assert.doesNotMatch(await dialog.innerText(), /through October 22/,
        variant + ': selected-period figures carry no active-period label');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);

      // Back to the current period: the card returns, unchanged.
      await step(page, -1, 5);
      assert.equal(await range(page), 'Oct 9 – Oct 22', variant + ': current period reselected');
      assert.equal(await cards(page), 1, variant + ': card returns on its own period');
      assert.equal(await amountText(page), expectedAmount, variant + ': amount unchanged after navigation');

      // Past period selected: same identity rule.
      await step(page, -1, 1);
      assert.equal(await range(page), 'Sep 25 – Oct 8', variant + ': past period selected');
      assert.equal(await cards(page), 0, variant + ': no Bills-closing card on a past period');
      await step(page, 1, 1);
      assert.equal(await cards(page), 1, variant + ': card returns after past-period detour');

      assert.deepEqual(errors, [], variant + ': no page errors');
      assert.deepEqual(writes, [], variant + ': no writes');
      assert.deepEqual(external, [], variant + ': no external requests');
      states.push(variant);
      await page.close();
      console.log(`PASS ${variant}: card stays bound to its own period across future, past and return navigation`);
    }
    console.log(JSON.stringify({ synthetic: true, head, states }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
