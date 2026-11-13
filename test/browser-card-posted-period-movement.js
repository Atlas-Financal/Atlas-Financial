'use strict';
// App.boot and real Budget controls, invented data, no live network or writes.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { chromium } = require('playwright');
const fx = require('./fixtures/card-posted-period-movement-data');
const root = path.join(__dirname, '..');
const before = process.env.ATLAS_CARD_MOVEMENT_BEFORE === '1';
const out = process.env.ATLAS_BUDGET_SCREENSHOTS_DIR || path.join(root, 'docs/proof/card-posted-period-movement');
fs.mkdirSync(out, { recursive: true });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  const evidence = { stage: before ? 'before' : 'after', fixture: 'invented', sources: {}, captures: [] };
  for (const rel of ['public/forecast-card-period.js', 'public/budget-card-movements.js',
    'public/budget-gface.css', 'public/budget-surface.css', 'test/fixtures/card-posted-period-movement-data.js'])
    evidence.sources[rel] = sha(fs.readFileSync(path.join(root, rel)));
  const errors = [], writes = [], external = [];
  for (const [width, theme] of [[1440, 'light'], [390, 'light'], [390, 'dark']]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.origin !== 'http://card-movement.test') { external.push(u.origin); return route.abort(); }
      if (route.request().method() !== 'GET') writes.push(route.request().method());
      if (u.pathname === '/data.json') return route.fulfill({ json: fx.served() });
      if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
      const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
      return fs.existsSync(file) ? route.fulfill({ body: fs.readFileSync(file),
        contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' })
        : route.fulfill({ status: 404, body: '' });
    });
    await page.goto('http://card-movement.test/');
    const strip = page.locator('[data-budget-card-movements]');
    await strip.waitFor();
    const travel = strip.locator('[data-budget-card-toggle="travelvisa"]');
    if (before) assert.equal(await strip.locator('[data-card-posted-movement]').count(), 0);
    else {
      for (const [id, expected] of Object.entries({ travelvisa: '+$107.40 this period', cashback: '−$135.80 this period',
        tdcc: 'No change this period', triangle: 'Unavailable', mbna: 'Unavailable' })) {
        const line = strip.locator('[data-budget-card-toggle="' + id + '"] [data-card-posted-movement]');
        assert.equal(await line.innerText(), expected);
        const geometry = await line.evaluate(el => {
          const rect = el.getBoundingClientRect(), balance = el.parentElement.querySelector('.card-movement-balance').getBoundingClientRect();
          return { top: rect.top, balanceBottom: balance.bottom, right: rect.right, balanceRight: balance.right,
            fits: el.parentElement.scrollWidth <= el.parentElement.clientWidth + 1 };
        });
        assert.ok(geometry.top >= geometry.balanceBottom - 1, id + ': line below balance');
        assert.ok(Math.abs(geometry.right - geometry.balanceRight) <= 2, id + ': shared right edge');
        assert.ok(geometry.fits, id + ': no clipping');
        const contrast = await line.evaluate(el => {
          const rgb = value => value.match(/[\d.]+/g).map(Number);
          const luminance = values => values.slice(0, 3).map(n => { n /= 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; })
            .reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
          let parent = el, bg;
          while (parent) {
            bg = rgb(getComputedStyle(parent).backgroundColor);
            if (bg.length < 4 || bg[3] > 0) break;
            parent = parent.parentElement;
          }
          const fg = luminance(rgb(getComputedStyle(el).color)), back = luminance(bg || [255, 255, 255]);
          return (Math.max(fg, back) + .05) / (Math.min(fg, back) + .05);
        });
        assert.ok(contrast >= 4.5, id + ': text contrast at least 4.5 (' + contrast + ')');
      }
    }
    await page.evaluate(async () => { await document.fonts.ready; });
    const file = (before ? 'before' : 'after') + '-' + theme + '-' + width + '.png';
    await strip.screenshot({ path: path.join(out, file), animations: 'disabled' });
    evidence.captures.push({ file, width, theme, sha256: sha(fs.readFileSync(path.join(out, file))) });
    await travel.click();
    const dialog = page.locator('#budget-detail-sheet');
    await dialog.waitFor({ state: 'visible' });
    assert.match(await dialog.innerText(), /Reported balance/);
    assert.match(await dialog.innerText(), /Pending/);
    const panel = dialog.locator('[data-budget-card-panel="travelvisa"]');
    assert.equal(await panel.locator('[data-card-movement-transaction]').count(), 6, 'five posted and one separate pending');
    assert.equal(await panel.locator('[data-card-posted-movement]').count(), 0, 'face publication does not alter drawer');
    await page.close();
  }
  assert.deepEqual(errors, [], 'no page errors');
  assert.deepEqual(writes, [], 'no writes');
  assert.deepEqual(external, [], 'no external calls');
  await browser.close();
  fs.writeFileSync(path.join(out, (before ? 'before' : 'after') + '.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log('PASS rendered card movement ' + evidence.stage + ': 3 viewport/theme captures; drawer preserved; no network writes');
})().catch(error => { console.error(error); process.exitCode = 1; });
