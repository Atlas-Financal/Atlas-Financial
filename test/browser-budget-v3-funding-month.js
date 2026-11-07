'use strict';
const { stepPeriod, openPeriodFigures } = require('./helpers/visible-period-navigation');
// Independent invented household, real App.boot and Forecast, all requests
// intercepted. No live data, credentials, captured or scaled household values.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');
const root = path.join(__dirname, '..');
const output = process.env.ATLAS_BUDGET_SCREENSHOTS_DIR || path.join(require('node:os').tmpdir(), 'atlas-funding-month');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const errors = [], external = [];
  try {
    for (const width of [1440, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce' });
      let data = fx.served();
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://budget.test') { external.push(url.origin); return route.abort(); }
        if (url.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return route.fulfill({ json: null });
        const file = path.join(root, 'public', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        return fs.existsSync(file) ? route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }) : route.fulfill({ status: 404, body: '' });
      });
      const boot = async () => { await page.goto('http://budget.test/'); await page.locator('[data-budget-funding-section]').waitFor(); };
      const geometry = async () => {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal page overflow');
        assert.equal(await page.locator('.budget-funding-cost-head').evaluateAll(rows => rows.every(row => row.scrollWidth <= row.clientWidth + 1)), true, 'cost names and amounts fit at 320px');
      };
      const visibleFocus = async selector => {
        const state = await page.locator(selector).evaluate(node => {
          const rect = node.getBoundingClientRect();
          const dock = document.querySelector('.sitenav-household')?.getBoundingClientRect();
          return { focused: node === document.activeElement, shown: !!node.getClientRects().length,
            top: rect.top, bottom: rect.bottom, limit: dock && dock.top > 0 ? dock.top : innerHeight };
        });
        assert.equal(state.focused && state.shown, true, 'exact restored trigger remains visible and focused');
        assert.ok(state.top >= 0 && state.bottom <= state.limit + 1, 'restored focus stays above the actual mobile dock');
      };
      const capture = async (name, selector) => {
        if (!selector) await page.evaluate(() => scrollTo(0, 0));
        await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
        const options = { path: path.join(output, `${name}-${width}.png`), animations: 'disabled' };
        return selector ? page.locator(selector).screenshot({ ...options, style: '.sitenav-household,.budget-section-nav {visibility:hidden !important;}' })
          : page.screenshot({ ...options, fullPage: true });
      };
      await boot();
      await geometry();
      const today = page.locator('[data-budget-funding-panel="today"]');
      assert.equal(await today.locator('[data-budget-funding-proposal]').innerText(), 'Unavailable',
        'without configured purpose pools the native daily proposal is unknown, not zero');
      assert.match(await today.innerText(), /Configured purpose pools are required/);
      assert.match(await page.locator('[data-budget-funding-context="today"]').innerText(), /Capacity is separate from the proposed contribution/);
      await capture('upcoming-today', '[data-budget-funding-section]');
      const tabs = page.locator('[data-budget-funding-tab]');
      await tabs.first().focus(); await page.keyboard.press('ArrowRight');
      assert.equal(await tabs.last().getAttribute('aria-selected'), 'true');
      assert.equal(await tabs.last().evaluate(node => node === document.activeElement), true);
      assert.equal(await today.isVisible(), false);
      const payday = page.locator('[data-budget-funding-panel="payday"]');
      assert.equal(await payday.isVisible(), true);
      assert.match(await tabs.last().innerText(), /Aug 28/);
      assert.match(await payday.innerText(), /Future payday projection[\s\S]*Complete exact payday funding plan/i);
      await capture('upcoming-payday', '[data-budget-funding-section]');
      const evidenceButton = payday.locator('[data-budget-funding-evidence]');
      await evidenceButton.focus(); await page.keyboard.press('Enter');
      await page.locator('[data-budget-detail-sheet]').waitFor({ state: 'visible' });
      assert.equal(await page.locator('[data-budget-detail-sheet]').evaluate(node => node.open), true);
      assert.match(await page.locator('[data-budget-detail-body]').innerText(), /August 28 payday|Aug 28/);
      await page.locator('[data-budget-detail-body] [data-payday-breakdown="planned-cost-funding"]').evaluate(node => { window.__originalPaydayFunding = node; });
      await page.evaluate(() => App.rerender());
      await page.locator('[data-budget-detail-sheet]').waitFor({ state: 'visible' });
      assert.equal(await page.locator('[data-budget-detail-body] [data-payday-breakdown="planned-cost-funding"]').evaluate(node => node !== window.__originalPaydayFunding), true,
        'rerender uses refreshed complete evidence rather than a cached packet');
      assert.equal(await page.locator('[data-budget-funding-tab="payday"]').getAttribute('aria-selected'), 'true', 'the selected lens survives evidence refresh');
      if (width === 390) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.locator('[data-budget-detail-sheet]').waitFor({ state: 'visible' });
        assert.equal(await page.locator('[data-budget-funding-tab="payday"]').getAttribute('aria-selected'), 'true', 'the selected lens survives responsive remount');
        await page.setViewportSize({ width, height: 1000 });
        await page.locator('[data-budget-detail-sheet]').waitFor({ state: 'visible' });
      }
      await page.keyboard.press('Escape');
      assert.equal(await evidenceButton.evaluate(node => node === document.activeElement), true);
      await visibleFocus('[data-budget-funding-panel="payday"] [data-budget-funding-evidence]');
      await tabs.last().focus(); await page.keyboard.press('Home');
      const todayButton = today.locator('[data-budget-funding-evidence]');
      // Preserve the independent earlier arithmetic without claiming that the
      // compatibility evidence is the native daily proposal or its Info node.
      const earlier = page.locator('[data-from-today-proposal]');
      assert.match(await earlier.textContent(), /1,375\.00[\s\S]*265\.00[\s\S]*308\.50/);
      assert.match(await earlier.textContent(), /501\.50/,
        'earlier capacity still reconciles: 1375 cash - 265 remaining bills - 308.50 household - 300 floor');
      await page.locator('[data-budget-daily-funding-evidence]').evaluate(node => { window.__fundingOriginal = node; });
      await todayButton.focus(); await page.keyboard.press('Enter');
      const nativeToday = page.locator('[data-budget-detail-body] [data-budget-daily-funding-evidence]');
      assert.equal(await nativeToday.evaluate(node => node === window.__fundingOriginal), true, 'original native daily evidence node is moved');
      assert.equal(await nativeToday.locator('[data-budget-daily-proposal]').innerText(), 'Unavailable');
      assert.match(await nativeToday.innerText(), /Configured purpose pools are required/);
      assert.doesNotMatch(await nativeToday.innerText(), /\$[0-9]/, 'unknown daily evidence cannot borrow the earlier capacity');
      await page.keyboard.press('Escape');
      assert.equal(await todayButton.evaluate(node => node === document.activeElement), true);
      await visibleFocus('[data-budget-funding-panel="today"] [data-budget-funding-evidence]');
      await page.locator('[data-budget-funding-inventory]').click();
      assert.match(await page.locator('[data-budget-detail-body]').innerText(), /unknown|await confirmation|not been supplied/i);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('[data-budget-funding-inventory]').evaluate(node => node === document.activeElement), true);
      await visibleFocus('[data-budget-funding-inventory]');
      const todayScope = await today.innerText();
      await stepPeriod(page, 'ArrowLeft');
      assert.match(await page.locator('[data-calendar-waterfall]').getAttribute('data-calendar-waterfall'), /2026-07-31/);
      assert.equal(await page.locator('[data-budget-funding-panel="today"]').innerText(), todayScope,
        'historical period selection keeps the dated current-cash proposal separate');
      await stepPeriod(page, 'ArrowRight');
      await stepPeriod(page, 'ArrowRight');
      assert.equal(await page.locator('[data-budget-funding-panel="today"]').innerText(), todayScope,
        'future period selection does not relabel current cash as a future receipt');
      await geometry();
      await openPeriodFigures(page);
      await page.locator('[aria-label="Budget planning granularity"] [data-budget-granularity="month"]').click();
      const shortcuts=page.locator('.budget-month-shortcuts');
      assert.equal(await shortcuts.isVisible(),width<960,'Month shortcuts add one quiet mobile row only');
      if(width<960) for(const section of ['result','flow','costs']) {
        const shortcut=shortcuts.locator(`[data-budget-month-section="${section}"]`);
        const heading=page.locator(`[data-budget-month-section-heading="${section}"]`);
        await shortcut.focus();await page.keyboard.press('Enter');
        assert.equal(await heading.evaluate(node=>node===document.activeElement),true,'shortcut moves keyboard focus to the section heading');
        assert.equal(await shortcut.getAttribute('aria-current'),'location');
        const before=await page.locator('[data-budget-month-view]').innerText();
        await page.evaluate(()=>App.rerender());
        assert.equal(await heading.evaluate(node=>node===document.activeElement),true,'live refresh restores the selected heading focus');
        assert.equal(await shortcut.getAttribute('aria-current'),'location','restored heading retains its shortcut location marker');
        assert.equal(await page.locator('[data-budget-month-view]').innerText(),before,'section navigation cannot change published Month evidence');
        await visibleFocus(`[data-budget-month-section-heading="${section}"]`);
      }
      await page.evaluate(()=>window.scrollTo(0,0));
      assert.equal(await page.locator('[data-budget-month-picker]').count(), 1);
      assert.equal(await page.locator('[data-budget-month-ladder-view]').count(), 1);
      assert.equal(await page.locator('[data-budget-month-ladder]').count(), 3);
      assert.match(await page.locator('.budget-v3-month').innerText(), /Published projection window[\s\S]*Each month funds itself/i);
      const reading = page.locator('[data-budget-reading-info]');
      assert.equal(await reading.getAttribute('open'), null, 'reading explanations start collapsed');
      await reading.locator('summary').focus(); await page.keyboard.press('Enter');
      assert.equal(await reading.evaluate(node => node.open), true, 'reading explanations are keyboard reachable');
      assert.equal(await reading.locator('summary').evaluate(node => getComputedStyle(node).outlineStyle), 'solid', 'reading info has visible keyboard focus');
      assert.match(await reading.innerText(), /Pending[\s\S]*Not confirmed[\s\S]*Unknown/);
      await page.keyboard.press('Enter');
      assert.equal(await reading.evaluate(node => node.open), false, 'keyboard closes reading explanations');
      await reading.locator('summary').evaluate(node => node.blur());
      assert.equal(await page.getByRole('button', { name: 'Preview missing data' }).count(), 0, 'prototype demo control never ships');
      await geometry(); await capture('month');
      await capture('month-flow', '.budget-v3-month-bottom > section:first-child');
      const picker = page.locator('[data-budget-month-picker]');
      await picker.selectOption('2026-09');
      assert.equal(await picker.evaluate(node => node === document.activeElement), true);
      assert.match(await page.locator('[data-budget-month-cost="school-trip"]').innerText(), /School trip/);
      assert.equal(await page.locator('[data-budget-month-cost="winter-tires"]').count(), 0, 'cash-date month membership, no other-month cost bleed');
      assert.match(await page.locator('[data-budget-month-funding-pressure]').innerText(), /outside this month can also affect/);
      await geometry(); await capture('month-costs', '.budget-v3-month-bottom > section:last-child');
      const monthEvidence = page.locator('[data-budget-month-funding-open]');
      await page.locator('[data-budget-month-funding-evidence]').evaluate(node => { window.__originalMonthFunding = node; });
      await monthEvidence.focus(); await page.keyboard.press('Enter');
      await page.locator('[data-budget-detail-sheet]').waitFor({ state: 'visible' });
      assert.equal(await page.locator('[data-budget-detail-body] [data-budget-month-funding-evidence]').evaluate(node => node === window.__originalMonthFunding), true,
        'Month opens the complete incumbent Month-input evidence node');
      assert.match(await page.locator('[data-budget-detail-body]').innerText(), /August 28|Aug 28/);
      await page.keyboard.press('Escape');
      await visibleFocus('[data-budget-month-funding-open]');
      await page.locator('[aria-label="Budget planning granularity"] [data-budget-granularity="pay-period"]').click();
      await page.locator('[data-budget-drilldown-exit]').click();
      data = fx.served({ withUndatedCost: true }); await boot();
      const undated = page.locator('[data-budget-funding-panel="today"] [data-budget-funding-cost="fixture-undated"]');
      assert.equal(await undated.count(), 1);
      assert.match(await undated.innerText(), /275\.00[\s\S]*Date not established[\s\S]*Contribution unknown/);
      assert.equal(await undated.locator('.budget-funding-track i').count(), 0);
      await geometry(); await capture('upcoming-undated', '[data-budget-funding-section]');
      for (const coverage of ['truncated', 'posted-only']) {
        data = fx.served({ withUndatedCost: true });
        if (coverage === 'truncated') data.liveOverlay.currentPeriodActuals.transactionCoverage = 'truncated';
        else data.liveOverlay.currentPeriodActuals.pendingCoverage = 'unknown';
        await boot();
        assert.match(await page.locator('[data-budget-funding-panel="today"] [data-budget-funding-proposal]').innerText(), /Unavailable/);
        await page.locator('[data-budget-funding-tab="payday"]').click();
        const cost = page.locator('[data-budget-funding-panel="payday"] [data-budget-funding-cost="fixture-undated"]');
        assert.match(await cost.innerText(), /Synthetic undated cost[\s\S]*275\.00[\s\S]*Contribution unknown/);
        assert.equal(await cost.locator('.budget-funding-track i').count(), 0);
        await geometry(); await capture(`upcoming-undated-${coverage}`, '[data-budget-funding-section]');
      }
      data = fx.served({ withheldSavings: true }); await boot();
      assert.match(await page.locator('[data-budget-funding-panel="today"] [data-budget-funding-proposal]').innerText(), /Unavailable/);
      assert.match(await page.locator('[data-budget-funding-section]').innerText(), /Explicit purpose pools are required/);
      assert.match(await page.locator('[data-budget-savings-goals]').innerText(), /Named savings unavailable/);
      // The retained occurrence evidence still names both unconfirmed costs;
      // it does not supply native daily assignments or purpose-pool amounts.
      assert.match((await page.locator('[data-budget-goal-fulfillment-evidence]').allTextContents()).join('\n'),
        /School trip[\s\S]*Not confirmed[\s\S]*Winter tires/);
      await page.locator('[data-budget-funding-tab="payday"]').click();
      assert.match(await page.locator('[data-budget-funding-panel="payday"] [data-budget-funding-proposal]').innerText(), /Unavailable/);
      await geometry(); await capture('upcoming-withheld', '[data-budget-funding-section]');
      data = fx.served({ zeroIncomeWithoutSpend: true }); await boot();
      assert.match(await page.locator('[data-budget-funding-panel="today"] [data-budget-funding-proposal]').innerText(), /Unavailable/);
      await openPeriodFigures(page);
      await page.locator('[aria-label="Budget planning granularity"] [data-budget-granularity="month"]').click();
      assert.match(await page.locator('[data-budget-month-view]').innerText(), /deficit|unavailable/i);
      await geometry(); await capture('month-zero-income');
      for (const [coverage, settlement] of [['missing', 'unverified'], ['partial', 'paid'], ['full', 'unverified'],
        ['full', 'paid'], ['truncated', 'unverified'], ['posted-only', 'paid']]) {
        data = fx.fundingHistorical(coverage, settlement); await boot();
        const ready = !['truncated', 'posted-only'].includes(coverage);
        const capacity = settlement === 'paid' ? /501\.50/ : /396\.50/;
        assert.match(await page.locator('[data-from-today-proposal]').textContent(), ready ? capacity : /unavailable|incomplete|withholding/i);
        assert.match(await page.locator('[data-budget-funding-context="today"]').innerText(), /Unavailable/);
        for (const role of ['past', 'current', 'next']) {
          if (role === 'past') await stepPeriod(page, 'ArrowLeft');
          else await stepPeriod(page, 'ArrowRight');
          const section = page.locator('[data-budget-funding-section]');
          assert.equal(await page.locator('[data-budget-funding-tab="today"]').innerText(), "From today's cash");
          assert.match(await page.locator('[data-budget-funding-context="today"]').innerText(), /Unavailable/);
          assert.equal(await page.locator('[data-budget-daily-funding-evidence]').count(), 1, 'one original native daily evidence source in every selection');
          assert.match(await page.locator('[data-from-today-proposal]').textContent(), ready ? capacity : /unavailable|incomplete|withholding/i);
          assert.match(await page.locator('[data-from-today-proposal]').textContent(), /2026-08-20/);
          const trigger = section.locator('[data-budget-funding-panel="today"] [data-budget-funding-evidence]');
          await trigger.focus(); await page.keyboard.press('Enter');
          await page.locator('[data-budget-detail-sheet]').waitFor({ state: 'visible' });
          const daily = page.locator('[data-budget-detail-body] [data-budget-daily-funding-evidence]');
          assert.match(await daily.innerText(), /Configured purpose pools are required/);
          assert.equal(await daily.locator('[data-budget-daily-proposal]').innerText(), 'Unavailable');
          assert.doesNotMatch(await daily.innerText(), /\$[0-9]/);
          await page.keyboard.press('Escape');
          await visibleFocus('[data-budget-funding-panel="today"] [data-budget-funding-evidence]');
          await geometry();
        }
        if (coverage === 'full' || coverage === 'truncated') await capture(`funding-history-${coverage}-${settlement}`, '[data-budget-funding-section]');
      }
      data = fx.served({ unavailablePlan: true });
      await page.goto('http://budget.test/');
      await page.locator('[data-budget-surface="unavailable"]').waitFor();
      assert.equal(await page.locator('[data-budget-funding-section]').count(), 0, 'untrusted refresh never exposes the funding renderer');
      await page.close();
      console.log(`PASS ${width}px: invented cash reconciliation, separate scopes, keyboard tabs, original evidence, focus restoration, Month hierarchy and cash-date membership`);
    }
    assert.deepEqual(errors, [], 'no browser errors'); assert.deepEqual(external, [], 'no external requests');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
