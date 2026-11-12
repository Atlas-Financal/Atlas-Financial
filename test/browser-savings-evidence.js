'use strict';
// Optional Playwright proof against the actual authenticated Atlas server.
// NODE_PATH=<playwright packages> CHROME_PATH=<browser> node test/browser-savings-evidence.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const { fixture, addPair, withServer } = require('./test-savings-evidence-integration');
const shots = process.env.ATLAS_SAVINGS_SCREENSHOTS || path.join(os.tmpdir(), 'atlas-savings-evidence-review');
async function main() {
  fs.mkdirSync(shots, { recursive: true });
  const input = fixture(); addPair(input.payload);
  await withServer(input, async server => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
    try {
      for (const width of [1440, 390, 320]) {
        const context = await browser.newContext({ viewport: { width, height: 900 },
          isMobile: width < 400, hasTouch: width < 400, reducedMotion: 'reduce' });
        const split = server.cookie.indexOf('=');
        await context.addCookies([{ name: server.cookie.slice(0, split), value: server.cookie.slice(split + 1),
          url: server.base, httpOnly: true, sameSite: 'Lax' }]);
        await context.route('**/*', route => new URL(route.request().url()).origin === server.base
          ? route.continue() : route.abort());
        const page = await context.newPage(), errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(server.base);
        const proposal = page.locator('[data-pay-period-swipe] [data-from-today-proposal]');
        await proposal.waitFor();
        const summary = proposal.locator(':scope > details > summary');
        assert.match(await summary.innerText(), /Proposal unavailable/);
        assert.doesNotMatch(await summary.innerText(), /evidence needed/);
        if (width < 400) await summary.tap();
        else { await summary.focus(); await page.keyboard.press('Enter'); }
        const issue = proposal.locator('[data-savings-evidence-reason="pending-possible-replacement"]');
        await issue.waitFor({ state: 'visible' });
        assert.match(await issue.innerText(), /Synthetic card.*Groceries.*2026-08-19/s);
        assert.match(await issue.innerText(), /one purchase or two/);
        assert.doesNotMatch(await proposal.innerText(), /\$/);
        const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
        assert.ok(await noOverflow(), 'phone/desktop page has no horizontal overflow at ' + width);
        const bounds = await issue.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
        await proposal.screenshot({ path: path.join(shots, 'hold-' + width + '.png') });
        // Native keyboard navigation changes only the selected period. The
        // dated hold returns when the user comes back to the current period.
        const wheel = page.locator('[data-budget-wheel="period"] [aria-current="true"]');
        await wheel.focus(); await page.keyboard.press('ArrowRight');
        await page.waitForFunction(() => !document.querySelector('[data-pay-period-swipe] [data-from-today-proposal]'));
        await page.locator('[data-budget-wheel="period"] [aria-current="true"]').focus(); await page.keyboard.press('ArrowLeft');
        await proposal.waitFor();
        assert.match(await proposal.innerText(), /Proposal unavailable/);
        // Strong adversarial label remains text and wraps on the narrow phone.
        const long = fixture(); addPair(long.payload);
        long.data.debts[0].label = '<img src=x onerror=alert(1)>' + 'LongAccountLabel'.repeat(12);
        server.write(long); await page.reload(); await proposal.waitFor();
        await proposal.locator(':scope > details > summary').click();
        assert.equal(await proposal.locator('img').count(), 0);
        assert.ok(await noOverflow(), 'long escaped label wraps at ' + width);
        assert.deepEqual(errors, [], 'no browser runtime errors');
        server.write(input);
        await context.close();
      }
    } finally { await browser.close(); }
  });
  console.log('PASS savings evidence browser: authenticated real page, 1440/390/320px, touch/keyboard, period navigation, wrapping, escaping; screenshots ' + shots);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
