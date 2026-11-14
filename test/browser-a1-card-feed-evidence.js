'use strict';
// Real App.boot and native details; invented data, intercepted GETs only.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { chromium } = require('playwright');
const fx = require('./fixtures/a1-card-feed-evidence-data');
const root = path.join(__dirname, '..');
const runtimeRoot = process.env.ATLAS_A1_RUNTIME_ROOT || root;
const before = process.env.ATLAS_A1_BEFORE === '1';
const stage = before ? 'revised-before' : 'revised-after';
const out = process.env.ATLAS_BUDGET_SCREENSHOTS_DIR || path.join(root, 'docs/proof/a1-card-feed-evidence');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(out, { recursive: true });
let browser;
(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  const evidence = { stage, fixture: 'invented', sources: {}, captures: [] };
  for (const rel of ['public/forecast.js', 'public/forecast-card-period.js', 'public/budget-card-movements.js',
    'public/budget-blend.js', 'public/plan.js', 'public/app.js', 'public/budget-surface.js',
    'public/budget-gface.css', 'public/budget-surface.css', 'test/fixtures/card-period-movements-data.js',
    'test/fixtures/card-posted-period-movement-data.js', 'test/fixtures/budget-surface-data.js',
    'test/fixtures/a1-card-feed-evidence-data.js', 'test/browser-a1-card-feed-evidence.js'])
    evidence.sources[rel] = hash(fs.readFileSync(path.join(rel.startsWith('public/') ? runtimeRoot : root, rel)));
  const errors = [], writes = [], external = [];
  for (const [width, theme] of [[1440, 'light'], [390, 'light'], [390, 'dark'], [320, 'light']]) {
    let liveData = fx.served();
    const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.origin !== 'http://a1.test') { external.push(u.origin); return route.abort(); }
      if (route.request().method() !== 'GET') writes.push(route.request().method());
      if (u.pathname === '/data.json') return route.fulfill({ json: liveData });
      if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
      const file = path.join(runtimeRoot, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
      return fs.existsSync(file) ? route.fulfill({ body: fs.readFileSync(file), contentType:
        file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' })
        : route.fulfill({ status: 404, body: '' });
    });
    await page.goto('http://a1.test/');
    const strip = page.locator('[data-budget-card-movements]');
    await strip.waitFor();
    for (const [id, expected] of Object.entries(before
      ? { travelvisa: '−$100.00 this period', tdcc: 'No change this period', cashback: '−$135.80 this period' }
      : { travelvisa: '−$100.00 this period · balance as of Aug 1',
        tdcc: 'No change this period · balance as of Aug 1', cashback: '−$135.80 this period' })) {
      const line = strip.locator('[data-budget-card-toggle="' + id + '"] [data-card-posted-movement]');
      assert.equal(await line.innerText(), expected, id);
      const box = await line.evaluate(el => { const r = el.getBoundingClientRect();
        const b = el.parentElement.querySelector('.card-movement-balance').getBoundingClientRect();
        return { below: r.top >= b.bottom - 1, aligned: Math.abs(r.right - b.right) <= 2,
          fits: el.parentElement.scrollWidth <= el.parentElement.clientWidth + 1 }; });
      assert.ok(box.below && box.aligned && box.fits, id + ': below balance, right aligned and unclipped ' + JSON.stringify({ width, box }));
    }
    const loc = page.locator('[data-budget-card-toggle="heloc"]');
    assert.equal(await loc.count(), 1, 'native LOC trigger exists');
    if (before) assert.equal(await loc.locator('.card-movement-net').count(), 0);
    else {
      const label = loc.locator('[data-card-movement-scope]');
      assert.equal(await label.innerText(), 'Activity in details');
      assert.equal(await loc.locator('[data-card-posted-movement]').count(), 0, 'LOC metric stays excluded');
      assert.ok(await label.evaluate(el => { const r = el.getBoundingClientRect();
        const b = el.parentElement.querySelector('.card-movement-balance').getBoundingClientRect();
        return r.top >= b.bottom - 1 && Math.abs(r.right - b.right) <= 2
          && el.parentElement.scrollWidth <= el.parentElement.clientWidth + 1;
      }), 'LOC label below balance, aligned and unclipped');
    }
    await page.evaluate(async () => { await document.fonts.ready; });
    const file = `${stage}-${theme}-${width}.png`;
    await strip.screenshot({ path: path.join(out, file), animations: 'disabled' });
    evidence.captures.push({ file, width, theme, sha256: hash(fs.readFileSync(path.join(out, file))) });
    const locFile = file.replace('.png', '-loc.png');
    await loc.screenshot({ path: path.join(out, locFile), animations: 'disabled' });
    evidence.captures.push({ file: locFile, width, theme, sha256: hash(fs.readFileSync(path.join(out, locFile))) });
    await strip.locator('[data-budget-card-toggle="travelvisa"]').click();
    const dialog = page.locator('#budget-detail-sheet');
    await dialog.waitFor({ state: 'visible' });
    const panel = dialog.locator('[data-budget-card-panel="travelvisa"]');
    assert.equal(await panel.locator('[data-card-movement-transaction]').count(), 2, 'both own-card payments remain in native detail');
    assert.match(await panel.innerText(), /Reported balance/);
    assert.match(await panel.innerText(), /pending/i);
    await page.keyboard.press('Escape');
    await loc.click();
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await dialog.locator('[data-budget-card-panel="heloc"] [data-card-movement-transaction]').count(), 4,
      'LOC keeps three posted rows and separate pending authorization');
    await page.keyboard.press('Escape');
    if (!before) {
      const line = id => page.locator('[data-budget-card-toggle="' + id + '"] [data-card-posted-movement]');
      const refresh = page.locator('[data-manual-refresh]');
      liveData.liveOverlay.overlays = liveData.liveOverlay.overlays.filter(row => row.locator !== 'debts:travelvisa');
      await refresh.click();
      await line('travelvisa').filter({ hasText: /^Unavailable$/ }).waitFor();
      assert.equal(await line('tdcc').innerText(), 'No change this period · balance as of Aug 1', 'other card cannot renew own date');
      liveData = fx.served();
      for (const id of ['travelvisa', 'tdcc'])
        liveData.liveOverlay.overlays.find(row => row.locator === 'debts:' + id).evidenceDate = '2026-08-20';
      await refresh.click();
      await line('travelvisa').filter({ hasText: /^−\$100.00 this period$/ }).waitFor();
      assert.equal(await line('tdcc').innerText(), 'No change this period', 'current idle card remains known zero');
      await refresh.click();
      await expectRefresh(page);
      assert.equal(await line('travelvisa').innerText(), '−$100.00 this period', 'repeat refresh never accumulates');
    }
    await page.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(external, []);
  await browser.close();
  fs.writeFileSync(path.join(out, evidence.stage + '.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log('PASS A1 rendered ' + evidence.stage + ': 4 viewport/theme captures, native card/LOC details, no writes');
})().catch(async error => { await browser?.close(); console.error(error); process.exitCode = 1; });
async function expectRefresh(page) { await page.waitForFunction(() => !document.querySelector('[data-manual-refresh]')?.disabled); }
