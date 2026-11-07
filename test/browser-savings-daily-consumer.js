'use strict';
const { openSavingsFunding } = require('./helpers/visible-savings-consumers');
// Real App.boot, blocked external requests, independently invented cash ledgers.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const cp = require('node:child_process'), { chromium } = require('playwright');
const fixture = require('./fixtures/savings-daily-consumer-data');
const root = path.resolve(__dirname, '..'), assets = process.env.ATLAS_DAILY_ASSETS || path.join(root, 'public');
const output = process.env.ATLAS_DAILY_PROOF || path.join(require('node:os').tmpdir(), 'atlas-daily-consumer');
const captureOnly = process.env.ATLAS_DAILY_CAPTURE_ONLY === '1';
const executionHead = cp.execFileSync('git', ['-c', 'safe.directory=' + root.replace(/\\/g, '/'), 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
fs.mkdirSync(output, { recursive: true });
(async () => {
 const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
 const errors = [], external = [], cases = [];
 try {
  for (const width of [1440, 390, 320]) for (const mode of ['ready', 'partial', 'full', 'multiple', 'returned', 'pending', 'unmatched', 'missing-stock', 'missing-cash', 'fully-backed', 'before-policy', 'saved-income', 'ranged-need', 'selector-exception', 'selector-malformed', 'selector-exception-stale-stock']) {
   const data = fixture(mode.startsWith('selector-') ? 'ready' : mode), page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
   await page.addInitScript(() => localStorage.setItem('hfd-plan-knobs-v1', JSON.stringify({ weeklyVariable: 40 })));
   page.on('pageerror', e => errors.push(e.message));
   await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://daily-savings.test') { external.push(url.origin); return route.abort(); }
    if (url.pathname === '/data.json') return route.fulfill({ json: data });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return route.fulfill({ json: null });
    const file = path.resolve(assets, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(assets + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    let bytes = fs.readFileSync(file);
    // Faults are injected only into this intercepted synthetic browser response.
    // The real App.boot, native inventory publisher and active renderer still run.
    if (url.pathname === '/forecast.js' && mode.startsWith('selector-')) {
     const fault = mode === 'selector-malformed'
      ? 'const packet = nativeDaily(...args); packet.currency = "USD"; return packet;'
      : 'throw new Error("Invented browser selector failure");';
     const stale = mode === 'selector-exception-stale-stock'
      ? 'const nativeRecommend = Forecast.recommend; Forecast.recommend = (...args) => { const advice = nativeRecommend(...args); advice.savingsInventory = JSON.parse(JSON.stringify(advice.savingsInventory)); advice.savingsInventory.reportedStock.asOf = "2026-10-04"; return advice; };'
      : '';
     bytes = Buffer.concat([bytes, Buffer.from(`\n{ const nativeDaily = Forecast.savingsDailyFunding; Forecast.savingsDailyFunding = (...args) => { ${fault} }; ${stale} }\n`)]);
    }
    return route.fulfill({ body: bytes, contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'text/html' });
   });
   await page.goto('http://daily-savings.test/');
   const overview = page.locator('.budget-blend-hero-layout');
   const summary = overview.locator('[data-operating-question="savings"] > details > summary');
   await summary.waitFor();
   const unchanged = await page.evaluate(() => JSON.stringify(App.data));
   await overview.screenshot({ path: path.join(output, `${mode}-overview-${width}.png`) });
   await summary.focus(); await page.keyboard.press('Enter');
   const dialog = page.locator('[data-budget-detail-sheet]'), body = page.locator('[data-budget-detail-body]');
   await dialog.waitFor({ state: 'visible' });
   if (!captureOnly) {
    const expected = { ready: 80, partial: 50, full: 0, multiple: 30, returned: 0, 'fully-backed': 0, 'saved-income': 80 }[mode];
    const amount = await body.locator('[data-budget-daily-proposal]').innerText();
    if (expected == null) assert.match(amount, /Unavailable/); else assert.match(amount, new RegExp(expected.toFixed(2).replace('.', '\\.')));
    assert.equal(await body.locator('[data-budget-savings-total-goal]').count(), 2);
    if (mode === 'partial') assert.match(await summary.innerText(), /149\.00/);
    if (mode === 'missing-stock') assert.match(await summary.innerText(), /Unavailable/);
    if (mode === 'missing-cash' || mode === 'before-policy') assert.match(await summary.innerText(), /119\.00/);
    if (mode === 'selector-exception' || mode === 'selector-malformed') assert.match(await summary.innerText(), /119\.00/, 'failed daily publication preserves independently verified stock');
    if (mode === 'selector-exception-stale-stock') assert.match(await summary.innerText(), /Unavailable/, 'failed daily publication cannot substitute stale stock');
    if (mode === 'ranged-need') {
     const home = body.locator('[data-budget-savings-total-goal="yearly-bill:home-cost"]');
     assert.match(await home.locator('[data-budget-savings-total-needed]').innerText(), /24\.00/);
     assert.match(await home.locator('[data-budget-savings-total-saved]').innerText(), /Unavailable/);
     assert.match(await home.locator('[data-budget-savings-proposed]').innerText(), /Unavailable/);
     assert.match(await body.locator('[data-budget-savings-total-goal="group:club"] [data-budget-savings-total-needed]').innerText(), /230\.00[\s\S]*250\.00/);
    }
    const info = body.locator('[data-budget-savings-info] > summary');
    await info.focus(); await page.keyboard.press('Enter');
    assert.match(await body.innerText(), /Only matched settled transfers/);
    if (mode === 'saved-income') assert.match(await body.innerText(), /160\.00[\s\S]*80\.00/);
    await page.keyboard.press('Escape');
    assert.equal(await summary.evaluate(el => el === document.activeElement), true, 'Savings sheet restores keyboard focus');
    await openSavingsFunding(page);
    const tab = page.locator('[data-budget-funding-tab="today"]');
    await tab.focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('[data-budget-funding-tab="payday"]').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Home');
    assert.equal(await tab.evaluate(el => el === document.activeElement), true);
    const today = page.locator('[data-budget-funding-panel="today"] [data-budget-funding-proposal]');
    if (expected == null) assert.match(await today.innerText(), /Unavailable/); else assert.match(await today.innerText(), new RegExp(expected.toFixed(2).replace('.', '\\.')));
    const evidence = page.locator('[data-budget-funding-evidence="today"]');
    await evidence.focus(); await page.keyboard.press('Enter'); await dialog.waitFor({ state: 'visible' });
    assert.equal(await body.locator('[data-budget-daily-proposal]').count(), 1);
    await page.keyboard.press('Escape'); assert.equal(await evidence.evaluate(el => el === document.activeElement), true);
    await summary.focus(); await page.keyboard.press('Enter'); await dialog.waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal overflow');
    assert.equal(await page.evaluate(() => JSON.stringify(App.data)), unchanged);
   }
   const infoDetails = body.locator('[data-budget-savings-info]').first();
   if (await infoDetails.count() && await infoDetails.evaluate(el => el.open)) await infoDetails.locator('summary').first().click();
   await dialog.screenshot({ path: path.join(output, `${mode}-detail-${width}.png`) });
   await page.keyboard.press('Escape');
   if (!captureOnly) {
    await page.reload(); await summary.waitFor(); await openSavingsFunding(page);
    const first = await page.locator('[data-budget-funding-panel="today"] [data-budget-funding-proposal]').innerText();
    await page.reload(); await summary.waitFor(); await openSavingsFunding(page);
    assert.equal(await page.locator('[data-budget-funding-panel="today"] [data-budget-funding-proposal]').innerText(), first, 'refresh replaces proposal');
    if (mode === 'ready') {
     const evidence = page.locator('[data-budget-funding-evidence="today"]');
     await evidence.focus(); await page.keyboard.press('Enter'); await dialog.waitFor({ state: 'visible' });
     for (const nextMode of ['partial', 'partial', 'multiple']) {
      await body.locator('[data-budget-savings-info] > summary').focus();
      assert.equal(await page.evaluate(next => {
       App.data.plan = next.plan; App.data.liveOverlay = next.liveOverlay;
       const before = JSON.stringify(App.data); App.rerender();
       return JSON.stringify(App.data) === before;
      }, fixture(nextMode)), true, 'in-place refresh does not mutate financial input');
      await dialog.waitFor({ state: 'visible' });
      assert.equal(await dialog.evaluate(el => el.open && el.contains(document.activeElement)), true, 'refresh keeps Today sheet open and keyboard focus inside');
      assert.match(await page.locator('[data-budget-detail-title]').innerText(), /Today: complete funding evidence/);
      const amount = nextMode === 'partial' ? '50' : '30';
      assert.match(await body.locator('[data-budget-daily-proposal]').innerText(), new RegExp(amount + '\\.00'));
      assert.match(await summary.innerText(), new RegExp((nextMode === 'partial' ? '149' : '169') + '\\.00'));
      assert.match(await overview.locator('[data-operating-question="07"] > details > summary').innerText(), /80\.00/);
      const info = body.locator('[data-budget-savings-info] > summary');
      await info.focus(); await page.keyboard.press('Enter');
      assert.match(await body.innerText(), /Only matched settled transfers/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await dialog.screenshot({ path: path.join(output, `refresh-${nextMode}-${width}.png`) });
     }
     await page.keyboard.press('Escape');
     assert.equal(await evidence.evaluate(el => el === document.activeElement), true, 'refreshed sheet restores the new Today trigger');
    }
   }
   cases.push({ mode, width }); await page.close(); console.log('Verified ' + mode + ' at ' + width + 'px');
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  assert.ok(cases.length > 0, 'at least one ledger/viewport case ran');
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ executionHead, assets, captureOnly, cases, errors, external, syntheticOnly: true }, null, 2));
  // Capture-only skips the assertions: it records evidence, it is never a pass.
  if (captureOnly) {
   console.log('CAPTURED (no assertions; not a pass): ' + cases.length + ' ledgers/viewports');
   process.exitCode = 1;
  } else console.log('PASS actual App.boot daily Savings: ' + cases.length + ' ledgers/viewports, keyboard/focus, unknowns, repeated refresh');
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
