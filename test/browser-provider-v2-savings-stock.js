'use strict';
const { applyPlanKnobsAfterWiring, planKnobsInitSource } = require('./browser-plan-knobs');
// Optional real-page proof; intercepted independent v2 observations, no login/server.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const cp = require('node:child_process'), { chromium } = require('playwright');
const root = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const O = require(path.join(root, 'scripts/provider-observe'));
const fx = require('./fixtures/savings-v2-observation-data');
const output = process.env.ATLAS_V2_STOCK_PROOF || path.join(require('node:os').tmpdir(), 'atlas-v2-stock');
const executionHead = cp.execFileSync('git', ['-c', 'safe.directory=' + root.replace(/\\/g, '/'),
  'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const known = new Set(['valid-v2', 'legacy-date', 'legacy-over-null', 'offset-date', 'calendar-date', 'v2-over-update', 'sender-unknown', 'pending-movement', 'household-midnight-current']);
const reported = new Set([...known, 'stale-date', 'stale-both', 'prior-year', 'prior-household-day', 'blocked-prior-day', 'withdrawal-stale', 'negative-stale', 'zero-stale']);
const modes = ['null-object-update', 'null-legacy-fetch', 'null-v2-sync', 'legacy-over-null',
  'valid-v2', 'legacy-date', 'offset-date', 'calendar-date', 'v2-over-update', 'sender-unknown',
  'stale-date', 'future-date', 'malformed-date', 'malformed-type', 'impossible-date',
  'missing-date', 'sync-only', 'foreign-currency', 'missing-account', 'duplicate-account', 'pending-movement',
  'stale-both', 'prior-year', 'prior-household-day', 'blocked-prior-day', 'household-midnight-current', 'withdrawal-stale', 'negative-stale', 'zero-stale'];
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const errors = [], external = [], cases = [];
  try {
    for (const width of [1440, 390, 320]) for (const mode of modes) {
      const { data } = fx.served(mode, O), before = JSON.stringify(data);
      const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      await page.addInitScript(applyPlanKnobsAfterWiring, { weeklyVariable: 40 });
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://v2-stock.test') { external.push(url.origin); return route.abort(); }
        if (url.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return route.fulfill({ json: null });
        const file = path.resolve(root, 'public', '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
        if (!file.startsWith(path.join(root, 'public') + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.css') ? 'text/css'
          : file.endsWith('.js') ? 'application/javascript' : 'text/html' });
      });
      await page.goto('http://v2-stock.test/?view=classic');
      const summary = page.locator('[data-operating-question="savings"] > details > summary');
      await summary.waitFor();
      const stock = summary.locator('.budget-step-value');
      // .budget-surface-period is display: contents on the blend face; the hero is its visible box.
      await page.locator('.blend-hero').screenshot({ path: path.join(output, mode + '-overview-' + width + '.png'),
        animations: 'disabled', style: '.sitenav-household{visibility:hidden!important}' });
      const amount = mode === 'withdrawal-stale' ? '$39.02' : mode === 'negative-stale' ? '−$3.12' : mode === 'zero-stale' ? '$0.00' : '$119.00';
      assert.equal(await stock.innerText(), reported.has(mode) ? amount : 'Unavailable', mode + ': active reported stock');
      if (reported.has(mode)) {
        // The hero pill hides its caption on the blend face (budget-blend.css
        // .blend-hero .budget-step-caption, since #548); the native date stays in
        // the DOM and the visible balance date is on the Savings goals card.
        const native = summary.locator('[data-budget-savings-observed-date]');
        const date = page.locator('[data-budget-savings-goals] > [data-savings-reported-balance]');
        assert.equal(await date.count(), 1);
        assert.equal(await date.isVisible(), true, 'balance date is visible at every viewport');
        assert.match(await date.innerText(), new RegExp(amount.replace(/[$.]/g, '\\$&').replace('−', '[−-]') + '[\\s\\S]*Balance dates '));
        if (['prior-household-day', 'blocked-prior-day'].includes(mode)) {
          assert.equal(await native.textContent(), 'Observed 2026-10-05');
          assert.match(await date.innerText(), /Balance dates Oct 5\. Dated balance — not current\./);
        }
        if (mode === 'prior-year') {
          assert.equal(await native.textContent(), 'Observed 2025-10-05');
          assert.match(await date.innerText(), /Balance dates Oct 5, 2025\. Dated balance — not current\./);
        }
      }
      assert.equal(await page.locator('[data-budget-period-result]').count(), 1, 'one final balance');
      assert.equal(await page.locator('[data-live-current-balance-amount]').count(), 1, 'one Current Balance');
      // The old funding-proposal panel left the live page (52acaa77, owner
      // decision 2026-11-11). The same Today proposal is read from the Savings
      // sheet the visible stock summary opens.
      assert.equal(await page.locator('[data-budget-funding-section], [data-budget-funding-panel]').count(), 0, 'removed funding-proposal panel stays off the page');
      const proposalText = async () => {
        await summary.focus(); await page.keyboard.press('Enter');
        await page.locator('[data-budget-detail-sheet]').waitFor({ state: 'visible' });
        const text = await page.locator('[data-budget-detail-body] [data-budget-daily-proposal]').innerText();
        await page.keyboard.press('Escape'); return text;
      };
      if (['sender-unknown', 'blocked-prior-day'].includes(mode)) {
        // Blend face: the native result text is kept screen-reader-only (.blend-clip) and the
        // visible figure is printed as the balanceAfterDeductions term; both must be Unavailable.
        const result = page.locator('[data-operating-question="07"] .budget-step-value');
        assert.equal(await result.locator('[data-blend-term="balanceAfterDeductions"]').innerText(), 'Unavailable');
        assert.equal(await result.locator('[data-blend-term="balanceAfterDeductions"]').isVisible(), true);
        assert.equal(await result.locator('.blend-clip').textContent(), 'Unavailable');
        assert.doesNotMatch(await result.textContent(), /\$/);
        assert.equal(await proposalText(), 'Unavailable');
      }
      if (!known.has(mode) || mode === 'pending-movement') assert.equal(await proposalText(), 'Unavailable');
      if (mode === 'valid-v2') assert.equal(await proposalText(), '$80.00',
        'independent preexisting ledger entitlement prints its published amount');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal overflow');
      await summary.focus(); await page.keyboard.press('Enter');
      const dialog = page.locator('[data-budget-detail-sheet]');
      await dialog.waitFor({ state: 'visible' });
      const body = page.locator('[data-budget-detail-body]');
      const info = body.locator('[data-budget-savings-info] > summary');
      await info.focus(); await page.keyboard.press('Enter');
      assert.match(await body.innerText(), /Only matched settled transfers/);
      await page.screenshot({ path: path.join(output, mode + '-evidence-' + width + '.png'), animations: 'disabled' });
      await page.keyboard.press('Escape');
      assert.equal(await summary.evaluate(el => el === document.activeElement), true, 'exact Savings trigger focus restoration');
      assert.equal(await page.evaluate(() => JSON.stringify(App.data)), before, 'browser input unchanged');
      cases.push({ mode, width, stockReady: reported.has(mode), currentBacking: known.has(mode), keyboardFocusRestored: true, noOverflow: true, inputUnchanged: true });
      await page.close();
      if (cases.length % modes.length === 0) console.log('PASS v2-stock ' + width + 'px: ' + modes.length + ' raw observer/Forecast/browser cases');
    }
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({
      executionHead, syntheticOnly: true, productionCredentialsUsed: false, cases, errors, external }, null, 2));
    console.log('PASS v2 observer -> Forecast -> active Budget browser: ' + cases.length + ' cases; unknowns and keyboard/focus preserved');
  } finally { await browser.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
