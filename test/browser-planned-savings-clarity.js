'use strict';
// Real App.boot/Forecast with independent invented HTTP responses only.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const fixture = require('./fixtures/planned-savings-clarity-data');
const fundingFixture = require('./fixtures/savings-funding-timeline');
const captureOnly = process.env.ATLAS_SAVINGS_CAPTURE_ONLY === '1';
const assets = process.env.ATLAS_SAVINGS_ASSETS_DIR || path.join(__dirname, '../public');
const output = process.env.ATLAS_SAVINGS_CLARITY_DIR || path.join(require('node:os').tmpdir(), 'atlas-planned-savings-clarity');
const executionHead = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
}).trim();
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const errors = [], external = [], cases = [];
  try {
    for (const width of [1440, 390, 320]) for (const mode of ['unconfirmed', 'ready', 'gap', 'backed', 'pool-deficit', 'stale', 'backed-ready', 'range', 'projection', 'projection-remaining', 'projection-missing-cash', 'projection-stale', 'stock-zero', 'stock-missing', 'stock-duplicate', 'stock-pending']) {
      const data = fixture(mode);
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      if (mode.startsWith('projection')) await page.addInitScript(() => {
        // Select the independent ledger's weekly setting through the incumbent
        // preference input, rather than comparing a different recommended plan.
        localStorage.setItem('hfd-plan-knobs-v1', JSON.stringify({ weeklyVariable: 35 }));
      });
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://savings-clarity.test') { external.push(url.origin); return route.abort(); }
        if (url.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return route.fulfill({ json: null });
        const file = path.resolve(assets, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
        if (!file.startsWith(assets + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'text/html' });
      });
      await page.goto('http://savings-clarity.test/');
      const summary = page.locator('.blend-hero-foot [data-operating-question="savings"] > details > summary');
      await summary.waitFor();
      assert.equal(await page.evaluate(() => App.data.meta.title), data.meta.title);
      if (!captureOnly) {
        const publication = await page.evaluate(({ plan, asOf }) => {
          const packet = Forecast.baselineTrajectory(plan, [], asOf, { weeklyVariable: 35 }).savingsFundingTimeline;
          return { source: packet.source, status: packet.status, permission: packet.actionPermission,
            actual: packet.actualContributions, contribution: packet.payPeriods[0].contribution,
            combined: packet.daily.find(row => row.date === packet.payPeriods[0].end).combined,
            undated: packet.payPeriods[0].goals.find(goal => goal.key === 'commitment:undated-a').projectedContribution };
        }, { plan: fundingFixture.fixture(), asOf: fundingFixture.AS_OF });
        assert.deepEqual(publication, { source: 'Forecast.savingsFundingTimeline', status: 'ready',
          permission: 'not-granted', actual: null, contribution: 310, combined: 465, undated: null },
        'actual loaded Forecast publishes the independently reconciled packet');
        const cashBoundary = await page.evaluate(({ plan, asOf }) => {
          delete plan.startingCash.breakdown[0].value;
          const missing = Forecast.baselineTrajectory(plan, [], asOf, { weeklyVariable: 35 }).savingsFundingTimeline;
          plan.startingCash.breakdown[0].value = 0; plan.startingCash.breakdown[1].value = 0;
          const zero = Forecast.baselineTrajectory(plan, [], asOf, { weeklyVariable: 35 }).savingsFundingTimeline;
          return { missing: { status: missing.status, days: missing.daily.length, periods: missing.payPeriods.length },
            zero: { status: zero.status, combined: zero.daily[0].combined } };
        }, { plan: fundingFixture.fixture(), asOf: fundingFixture.AS_OF });
        assert.deepEqual(cashBoundary, { missing: { status: 'unavailable', days: 0, periods: 0 },
          zero: { status: 'ready', combined: 575 } }, 'active publication distinguishes unknown operating cash from explicit zero');
      }
      const inputs = await page.evaluate(() => JSON.stringify(App.data));
      const todayCard = page.locator('[data-budget-today-cash]');
      await todayCard.evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 120));
      await todayCard.screenshot({ path: path.join(output, `${mode}-today-${width}.png`), animations: 'disabled' });
      if (!captureOnly) {
        assert.equal(await page.locator('[data-budget-cash-withheld]').count(), 0, 'marked duplicate callout removed');
        const how = page.locator('[data-budget-cash-how]');
        await how.focus(); await page.keyboard.press('Enter');
        await page.locator('[data-budget-today-evidence]').waitFor({ state: 'visible' });
        assert.match(await page.locator('[data-budget-today-evidence]').innerText(), /funding|allocation|evidence/i);
        await page.locator('[data-budget-cash-back]').focus(); await page.keyboard.press('Enter');
        assert.equal(await how.evaluate(el => el === document.activeElement), true, 'current funding Info retains keyboard focus restoration');
      }
      const overview = page.locator('.budget-blend-hero-layout');
      const resultSummary = overview.locator('[data-operating-question="07"] > details > summary');
      const resultText = await resultSummary.innerText();
      if (!captureOnly) {
        assert.equal(await summary.evaluate(el => Boolean(el.closest('[data-budget-savings-stock]'))), true);
        assert.equal(await overview.evaluate(el => {
          const result = el.querySelector('[data-operating-question="07"]');
          const stock = el.querySelector('[data-operating-question="savings"]');
          return Boolean(result.compareDocumentPosition(stock) & Node.DOCUMENT_POSITION_FOLLOWING);
        }), true, 'stock follows Balance After Deductions');
        assert.equal(await summary.locator('.budget-waterfall-track,.budget-waterfall-bar,.budget-progress-track').count(), 0);
        assert.equal(await summary.locator('.operating-number').innerText(), '•');
        const stockText = await summary.locator('.budget-step-value').innerText();
        if (['projection', 'projection-remaining', 'projection-missing-cash'].includes(mode)) assert.equal(stockText, '$80.00');
        if (mode === 'backed-ready' || mode === 'stock-pending') assert.equal(stockText, '$500.03');
        if (mode === 'stock-zero') assert.equal(stockText, '$0.00', 'known zero is not unknown');
        if (['projection-stale', 'stale', 'stock-missing', 'stock-duplicate'].includes(mode)) assert.equal(stockText, 'Unavailable');
        if (mode === 'backed-ready') assert.match(resultText, /322\.04/, 'observed stock is neither added nor subtracted');
        if (['stock-zero', 'stock-missing', 'stock-duplicate', 'stock-pending'].includes(mode)) assert.match(resultText, /500\.00/);
      }
      await overview.evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 120));
      if (!captureOnly) assert.equal(await summary.evaluate(el => {
        const rect = el.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom < innerHeight - 80;
      }), true, 'stock row is visible above the fixed mobile navigation');
      await overview.screenshot({ path: path.join(output, `${mode}-overview-${width}.png`), animations: 'disabled' });
      if (!captureOnly) {
        await resultSummary.focus(); await page.keyboard.press('Tab');
        assert.equal(await summary.evaluate(el => el === document.activeElement), true,
          'the stock disclosure follows the final result in keyboard order');
      } else await summary.focus();
      await page.keyboard.press('Enter');
      const dialog = page.locator('[data-budget-detail-sheet]');
      const body = dialog.locator('[data-budget-detail-body]');
      await dialog.waitFor({ state: 'visible' });
      const info = body.locator('[data-budget-savings-info]');
      if (!captureOnly) {
        assert.equal(await info.evaluate(el => el.open), false);
        const text = await body.innerText();
        assert.doesNotMatch(text, /original payday|snapshot|attributable|Confirmed fulfilled|Remaining this period:/);
        if (mode.startsWith('projection')) {
          assert.equal(await body.locator('[data-budget-savings-total-goal]').count(), 3);
          assert.equal(await body.locator('[data-budget-savings-total-saved]').filter({ hasText: 'Unknown' }).count(), 3);
          assert.match(await summary.innerText(), mode === 'projection-stale' ? /Unavailable/ : /80\.00/,
            'observed account stock stays distinct from hypothetical proposals');
          const camp = body.locator('[data-budget-savings-total-goal="group:camp-a"]');
          const annual = body.locator('[data-budget-savings-total-goal="yearly-bill:annual-a"]');
          assert.match(await camp.innerText(), /280\.00/);
          if (['projection', 'projection-remaining'].includes(mode)) {
            assert.doesNotMatch(text, /projected|projection/i);
            assert.match(await camp.locator('[data-budget-savings-projection]').innerText(), mode === 'projection' ? /270\.00/ : /0\.00/);
            assert.match(await annual.locator('[data-budget-savings-projection]').innerText(), mode === 'projection' ? /40\.00/ : /0\.00/);
            assert.match(text, mode === 'projection' ? /This period/ : /Remaining this period/);
            assert.equal(await body.locator('[data-budget-savings-projection-gap]').count(), mode === 'projection-remaining' ? 1 : 0);
          } else assert.equal(await body.locator('[data-budget-savings-projection]').count(), 0);
          assert.match(await body.locator('[data-budget-savings-total-goal="commitment:undated-a"] [data-budget-savings-proposed]').innerText(), /Unknown/);
        } else if (['unconfirmed', 'backed', 'pool-deficit', 'stale', 'range'].includes(mode)) {
          assert.equal((text.match(/Funding plan not confirmed/g) || []).length, 1);
          assert.equal(await body.locator('[data-budget-savings-total-goal]').count(), mode === 'unconfirmed' ? 4 : 3);
          if (mode === 'unconfirmed') {
            assert.match(text, /Invented classes[\s\S]*143\.00/);
            assert.doesNotMatch(text, /\$0\.00/);
          } else {
            const trip = body.locator('[data-budget-savings-total-goal="commitment:trip-a"]');
            assert.match(await trip.innerText(), /403\.21/);
            assert.match(await trip.locator('[data-budget-savings-total-saved]').innerText(), ['backed', 'range'].includes(mode) ? /215\.04/ : /Unknown/);
            if (mode === 'range') assert.match(await trip.locator('[data-budget-savings-total-needed]').innerText(), /403\.21[\s\S]*500\.00/);
          }
          const rows = body.locator('[data-budget-savings-total-goal]');
          const heights = await rows.evaluateAll(nodes => nodes.map(el => el.getBoundingClientRect().height));
          assert.ok(heights.every(height => height <= 110), 'each total/period row stays compact');
          assert.ok((await body.boundingBox()).height < 140 + heights.length * 110, 'only the short status, goal rows and Info are visible');
        } else if (mode === 'backed-ready') {
          const goal = body.locator('[data-budget-savings-total-goal="commitment:named-cost"]');
          assert.equal(await body.locator('[data-budget-savings-total-goal]').count(), 1);
          assert.match(await goal.innerText(), /215\.04[\s\S]*600\.00/);
          assert.match(await goal.locator('[data-budget-savings-proposed]').innerText(), /177\.96/);
          assert.match(await summary.innerText(), /500\.03/);
        } else if (mode.startsWith('stock-')) {
          assert.equal(await body.locator('[data-budget-savings-total-goal]').count(), 1);
          assert.match(await body.locator('[data-budget-savings-total-saved]').innerText(), /Unknown/);
          assert.match(text, /Funding plan not confirmed/);
        } else {
          assert.equal(await body.locator('[data-budget-savings-total-goal]').count(), 0, 'missing total-stock publication does not use period requirements');
          assert.match(text, /Total goal savings not confirmed/);
          if (mode === 'ready') assert.match(await summary.innerText(), /Unavailable/, 'proposed period funding is not an observed account balance');
          else assert.match(text, /Funding shortfall:/);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await body.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
      }
      await dialog.screenshot({ path: path.join(output, `${mode}-${width}.png`), animations: 'disabled' });
      if (!captureOnly) {
        const infoSummary = info.locator(':scope > summary');
        await infoSummary.focus(); await page.keyboard.press('Enter');
        assert.equal(await info.evaluate(el => el.open), true, 'Info is keyboard reachable');
        assert.ok(await body.locator('[data-budget-goal-fulfillment-evidence]').count() >= 3, 'complete roster retained');
        if (['ready', 'gap', 'unconfirmed'].includes(mode)) assert.match(await body.innerText(), /Invented goal with a deliberately long name/);
        assert.match(await body.innerText(), /Attributable contributions|assignments|current Forecast/i);
        if (mode === 'stock-pending') assert.match(await body.innerText(), /Pending movement evidence is unresolved/);
        if (['projection', 'projection-remaining'].includes(mode)) {
          assert.match(await body.innerText(), /Hypothetical projection/);
          assert.match(await body.innerText(), /Actual contributions unknown/);
        }
        await infoSummary.focus(); await page.keyboard.press('Enter');
        assert.equal(await info.evaluate(el => el.open), false);
        await page.keyboard.press('Escape');
        assert.equal(await summary.evaluate(el => el === document.activeElement), true, 'dismissal restores exact summary focus');
        assert.equal(await resultSummary.innerText(), resultText, 'opening and closing stock details cannot change the result');
        assert.equal(await page.evaluate(() => JSON.stringify(App.data)), inputs, 'disclosures do not mutate financial inputs');
        if (mode === 'projection') {
          await page.locator('[data-budget-window-step="1"]').focus(); await page.keyboard.press('Enter');
          await summary.focus(); await page.keyboard.press('Enter');
          await dialog.waitFor({ state: 'visible' });
          assert.match(await body.innerText(), /This period/);
          assert.match(await body.locator('[data-budget-savings-total-goal="group:camp-a"] [data-budget-savings-projection]').innerText(), /0\.00/);
          assert.match(await body.locator('[data-budget-savings-total-saved]').first().innerText(), /Unknown/);
          await dialog.screenshot({ path: path.join(output, `projection-next-${width}.png`), animations: 'disabled' });
          await page.keyboard.press('Escape');
          assert.equal(await summary.evaluate(el => el === document.activeElement), true);
          for (let i = 0; i < 2; i++) {
            await page.locator('[data-budget-window-step="-1"]').focus(); await page.keyboard.press('Enter');
          }
          await summary.focus(); await page.keyboard.press('Enter');
          await dialog.waitFor({ state: 'visible' });
          assert.equal(await body.locator('[data-budget-savings-projection]').count(), 0, 'historical selection does not inherit future projected contributions');
          await page.keyboard.press('Escape');
          assert.equal(await summary.evaluate(el => el === document.activeElement), true);
          assert.equal(await page.evaluate(() => JSON.stringify(App.data)), inputs);
        }
      }
      cases.push({ width, mode, captureOnly }); await page.close();
    }
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    const receipt = { executionHead, assetsCommit: process.env.ATLAS_SAVINGS_ASSETS_COMMIT || executionHead,
      cases, errors, external, syntheticOnly: true };
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(receipt, null, 2) + '\n');
    console.log((captureOnly ? 'CAPTURE' : 'PASS actual App.boot') + ' Planned Savings: ' + cases.length + ' states, desktop/390/320, Info keyboard/focus and unchanged inputs');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
