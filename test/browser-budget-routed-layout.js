'use strict';
// Optional Chromium proof of server routing, authentication, App.boot and the
// real Forecast. Only the three financial JSON responses are synthetic.
// CHROME_PATH=/usr/bin/chromium node test/browser-budget-routed-layout.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const makeData = require('./fixtures/budget-layout-data');
const makeFundingData = require('./fixtures/budget-funding-data');
const root = path.join(__dirname, '..');
const screenshots = process.env.ATLAS_BUDGET_SCREENSHOTS_DIR
  || path.join(require('node:os').tmpdir(), 'atlas-budget-routed-review');
fs.mkdirSync(screenshots, { recursive: true });

(async () => {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const syntheticPassword = randomBytes(24).toString('hex');
  const syntheticSession = randomBytes(32).toString('hex');
  // Explicit environment: never inherit any integration credential or enable
  // a live overlay/provider call while testing a presentation change.
  const server = spawn(process.execPath, ['server.js'], { cwd: root,
    env: { PATH: process.env.PATH, PORT: String(port), NODE_ENV: 'test',
      SITE_PASSWORD: syntheticPassword,
      SESSION_SECRET: syntheticSession, ATLAS_LIVE_OVERLAY: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', chunk => { serverLog += chunk; });
  server.stderr.on('data', chunk => { serverLog += chunk; });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(`${base}/login`)).ok; } catch { /* starting */ }
      if (ready) break;
      if (server.exitCode != null) throw new Error(serverLog);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'synthetic local server must start');
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH,
      args: ['--no-sandbox'] });
    const errors = [], external = [];
    for (const width of [1440, 390, 320]) {
      let data = makeData();
      const context = await browser.newContext({ viewport: { width, height: 900 },
        hasTouch: width < 400, isMobile: width < 400,
        colorScheme: 'light', reducedMotion: 'reduce' });
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== base) {
          external.push(url.origin); return route.abort();
        }
        if (url.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json'].includes(url.pathname)) {
          return route.fulfill({ json: null });
        }
        return route.continue();
      });
      const login = await context.request.post(`${base}/login`, {
        form: { password: syntheticPassword } });
      assert.ok(login.ok());
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto(base);
      await page.locator('.budget-step-summary').first().waitFor();
      assert.equal(await page.evaluate(() => App.data.meta.title), 'Synthetic Budget review');
      const stepDetails = await page.locator('.budget-step-details').evaluateAll(rows => rows.map(el =>
        el.closest('[data-operating-question]')?.getAttribute('data-operating-question')
        || (el.closest('[data-from-today-proposal]') ? 'today' : 'other')).sort());
      assert.deepEqual(stepDetails, ['02', '04', '05', '06', '07', 'savings', 'today']);
      assert.equal(await page.locator('.atlas-budget-section').count(), 0);
      const balance = await page.locator('[data-live-current-balance]').boundingBox();
      // The blend face puts the period header and river above the Bills-account
      // chip; the balance must still sit wholly inside the first viewport (900px).
      assert.ok(balance.y >= 0 && balance.y + balance.height <= 900 && balance.height < 250, JSON.stringify(balance));
      assert.match(await page.locator('[data-live-current-balance]').innerText(), /2,500\.00/);
      // The retired folded "Current payday details" disclosure is gone: the
      // payday instruction shell lives in the Today card's evidence section,
      // hidden until the ⓘ control opens it.
      assert.equal(await page.locator('[data-current-payday-details]').count(), 0);
      assert.equal(await page.locator('[data-budget-today-evidence]').isVisible(), false);
      const sheet = page.locator('[data-budget-detail-sheet]');
      const sheetOpen = () => sheet.evaluate(el => el.open);
      // The visible period control is the river slider; the native wheels are
      // hidden and selected through it (budget-blend.js). Drive it by keyboard.
      const printed = locator => locator.evaluate(el => el.textContent.replace(/\s+/g, ' '));
      const river = async key => {
        await page.locator('.river').focus();
        await page.keyboard.press(key);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.waitForTimeout(500);
      };
      // Step the river forward from the current period to the 2027 period.
      const riverToJanuary = async () => {
        for (let i = 0; i < 40; i++) {
          if (/Jan 1, 2027 – Jan 14, 2027/.test(await page.locator('[data-selected-pay-period-range]').innerText())) return;
          await river('ArrowRight');
        }
      };
      assert.equal(await page.getByRole('heading', { name: "Today's money", exact: true }).isVisible(), false);
      // The waterfall wrapper is display:contents on the blend face; its first step row stands in.
      const waterfall = await page.locator('.budget-step-summary').first().boundingBox();
      assert.ok(balance.y + balance.height <= waterfall.y);
      assert.equal(await page.locator('#road-ahead').isVisible(), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(screenshots, `routed-${width}-current.png`), fullPage: true });
      const income = page.locator('[data-operating-question="02"] .budget-step-summary');
      // Step summaries open the detail sheet (a modal dialog); Escape closes it
      // and returns focus to the summary that opened it.
      await income.focus();
      assert.equal(await sheetOpen(), false);
      await page.keyboard.press('Enter');
      assert.equal(await sheetOpen(), true);
      assert.equal(await sheet.evaluate(el => el.contains(document.activeElement)), true);
      await page.keyboard.press('Escape');
      assert.equal(await sheetOpen(), false);
      assert.equal(await income.evaluate(el => document.activeElement === el), true);
      await page.keyboard.press('Space');
      assert.equal(await sheetOpen(), true);
      await page.keyboard.press('Escape');
      assert.equal(await sheetOpen(), false);
      // Full-cycle click across a year boundary keeps both nav rows linked.
      await riverToJanuary();
      assert.match(await page.locator('[data-selected-pay-period-range]').innerText(),
        /Jan 1, 2027 – Jan 14, 2027/);
      // The Today card is always the dated current Bills position, whichever period is selected.
      assert.match(await page.locator('[data-budget-today-cash] .budget-cash-eyebrow').innerText(), /^(Today|Dated refresh)/);
      assert.match(await page.locator('[data-live-current-balance]').innerText(), /2,500\.00/);
      const expected = { '02': '3,849.40', '04': '1,799.00', '05': '2,050.40', '07': '1,950.40' };
      for (const [id, amount] of Object.entries(expected)) {
        // Some steps sit in a collapsed hero panel on the blend face; read the printed text, not the layout.
        const header = await printed(page.locator(`[data-operating-question="${id}"] .budget-step-summary`));
        assert.ok(header.includes(amount), `${id}: ${header}`);
        if (id !== '04') assert.match(header, /≈\s*estimated/);
        else assert.doesNotMatch(header, /≈\s*estimated/);
      }
      await page.screenshot({ path: path.join(screenshots, `routed-${width}-2027-estimated.png`), fullPage: true });
      await income.click();
      assert.match(await page.locator('[data-period-income="payroll"]').innerText(), /≈\s*estimated/);
      await page.keyboard.press('Escape');
      assert.equal(await sheetOpen(), false);
      // Genuine touch swipe through the production listener, then back.
      if (width < 400) {
        const touch = await context.newCDPSession(page);
        const swipe = async left => {
          const wheel = page.locator(".river");
          await wheel.scrollIntoViewIfNeeded();
          const box = await wheel.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
          await touch.send('Input.dispatchTouchEvent', { type: 'touchStart',
            touchPoints: [{ x: x + (left ? 55 : -55), y }] });
          for (let i = 1; i <= 6; i++) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove',
            touchPoints: [{ x: x + (left ? 55 : -55) + (left ? -125 : 125) * i / 6, y }] });
          await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await page.waitForTimeout(350);
        };
        const selected = () => page.locator('[data-pay-period-swipe]').getAttribute('data-selected-pay-period');
        const first = await selected();
        for (let i = 0; i < 3; i++) {
          await swipe(true); assert.notEqual(await selected(), first);
          await swipe(false); assert.equal(await selected(), first);
        }
        await touch.detach();
        await page.waitForTimeout(500);
        assert.equal(await sheetOpen(), false, 'a wheel swipe must not open the household sheet');
        await page.locator('[data-operating-question="06"] .budget-step-summary').tap();
        await page.waitForFunction(() => document.querySelector('[data-budget-detail-sheet]').open,
          null, { timeout: 2000 });
        await page.keyboard.press('Escape');
        assert.equal(await sheetOpen(), false);
      }
      // Unknown source trust stays unavailable through the real bootstrap.
      data.plan.bills[1].confidence = 'unknown';
      await page.waitForLoadState("networkidle");
      await page.reload();
      await page.locator('.budget-step-summary').first().waitFor();
      await riverToJanuary();
      for (const id of ['04', '05', '07']) assert.match(
        await printed(page.locator(`[data-operating-question="${id}"] .budget-step-summary`)), /Unavailable/);
      data.plan.startingCash.breakdown = [];
      await page.waitForLoadState("networkidle");
      await page.reload();
      await page.locator('.budget-step-summary').first().waitFor();
      // The hero balance prints Unavailable, never an invented $0.00 (the
      // evidence section below it holds other, separately published figures).
      const hero = page.locator('[data-budget-cash-hero]');
      assert.doesNotMatch(await hero.innerText(), /\$0\.00/);
      assert.match(await hero.innerText(), /Unavailable/);

      // Same authenticated production route, now with independently checked
      // Budget contributions. This is real Forecast output, not injected HTML.
      data = makeFundingData();
      await page.waitForLoadState("networkidle");
      await page.reload();
      const named = page.locator('[data-budget-funding-item="named-cost"]');
      const stepText = id => printed(page.locator(`[data-operating-question="${id}"] .budget-step-summary`));
      const rangeText = () => page.locator('[data-selected-pay-period-range]').innerText();
      // The named-cost funding rows are evidence inside the savings sheet:
      // open the sheet, then its Info and earlier-calculation disclosures.
      const openNamed = async () => {
        await page.locator('[data-operating-question="savings"] .budget-step-summary').click();
        assert.equal(await sheetOpen(), true);
        // Open each closed disclosure on the way down to the named cost.
        for (let i = 0; i < 4 && !await named.isVisible(); i++) {
          await sheet.locator('details:not([open]) > summary').first().click();
        }
        await named.waitFor({ state: 'visible' });
      };
      const closeSheet = async () => {
        await page.keyboard.press('Escape');
        assert.equal(await sheetOpen(), false);
      };
      // The reload restores the selected period for this tab; "T" returns the
      // river to the current period.
      await river('t');
      assert.match(await rangeText(), /Aug 14, 2026 – Aug 27, 2026/);
      assert.equal(await page.locator('[data-plan-spend-earmark]').count(), 0,
        'the selected Budget schedule must not compete with the old cap-basis banner');
      // Hand arithmetic: $1,000 income - $200 bill - $300 groceries = $500
      // before unsent savings top-ups; the named $600 cost is proposed $250
      // this period (cumulative $250 / $600), $350 still to set aside.
      assert.match(await stepText('07'), /500\.00/);
      // The savings step is the observed combined balance (none here); item
      // funding is separate and reads in the Upcoming funding card below.
      assert.match(await stepText('savings'), /Unavailable/);
      await openNamed();
      assert.match(await named.innerText(), /250\.00\s*\/\s*\$600\.00/);
      assert.match(await named.innerText(), /Still to set aside after this period\s+\$350\.00/);
      assert.match(await named.innerText(), /Actual saved: unavailable/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(screenshots, `routed-${width}-funding-current.png`), fullPage: true });
      await closeSheet();
      // Next period: $1,000 - $200 - $150 later bill - $300 = $350, all of it
      // proposed, completing the $600 cost and leaving $0.00 after funding.
      await river('ArrowRight');
      assert.match(await rangeText(), /Aug 28, 2026 – Sep 10, 2026/);
      assert.match(await stepText('07'), /350\.00/);
      assert.match(await stepText('07'), /After proposed savings\s*\$0\.00/);
      await openNamed();
      assert.match(await named.innerText(), /\$600\.00\s*\/\s*\$600\.00/);
      assert.match(await named.innerText(), /Still to set aside after this period\s+\$0\.00/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(screenshots, `routed-${width}-funding-next.png`), fullPage: true });
      await closeSheet();

      // An unknown-trust cost prints Unavailable, never a made-up figure.
      data.plan.commitments[0].confidence = 'unknown';
      await page.waitForLoadState("networkidle");
      await page.reload();
      await page.locator('.budget-step-summary').first().waitFor();
      assert.match(await rangeText(), /Aug 28, 2026 – Sep 10, 2026/);
      await openNamed();
      assert.match(await named.innerText(), /Named cost/i);
      assert.match(await named.innerText(), /This period — proposed\s*Unavailable/);
      assert.doesNotMatch(await named.innerText(), /\$0\.00/);
      await closeSheet();
      // With the funding deduction unavailable the balance is labelled as before savings.
      assert.match(await page.locator('[data-budget-surface]')
        .evaluate(el => el.textContent.replace(/\s+/g, ' ')), /Before savings/);
      await context.close();
    }
    assert.deepEqual(external, [], 'routed proof must make no provider or external requests');
    assert.deepEqual(errors, []);
    console.log('PASS authenticated production Budget route + App.boot + real Forecast: 1440/390/320 first viewport, Current Balance first, payday details folded into the Today evidence, 2027 estimate propagation, unknown trust, proposed funding/current-next progress and gap, keyboard/focus/detail sheet, repeated real touch swipes, no overflow/errors/external requests. All financial JSON is synthetic.');
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    await new Promise(resolve => { if (server.exitCode != null) resolve(); else server.once('exit', resolve); });
  }
})().catch(error => { console.error(error); process.exit(1); });
