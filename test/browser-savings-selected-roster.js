'use strict';
// Real navigation and both Savings renderers; only intercepted invented GETs.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const make = require('./fixtures/savings-selected-roster-data');
const shell = require('./fixtures/savings-daily-consumer-data');
const root = path.resolve(__dirname, '..'), assets = path.join(root, 'public');
const out = process.env.ATLAS_ROSTER_PROOF || path.join(require('node:os').tmpdir(), 'atlas-roster-proof');
fs.mkdirSync(out, { recursive: true });
const served = {}, cases = [], errors = [], external = [], writes = [];
async function step(page, direction) {
  const before = await page.locator('[data-budget-window-progress]').getAttribute('data-start');
  await page.locator('.river').focus();
  await page.keyboard.press(direction > 0 ? 'ArrowRight' : 'ArrowLeft');
  await page.waitForFunction(start => document.querySelector('[data-budget-window-progress]')?.dataset.start !== start, before);
}
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    for (const width of [1440, 390]) for (const mode of ['ready', 'card', 'missing', 'stale']) {
      const x = make(mode), data = shell('ready'); data.plan = x.plan; data.meta.asOf = x.asOf;
      data.liveOverlay = { applied: true, operatingPlan: 'live', ...x.opts,
        observedCash: { asOf: x.asOf, complete: true, accounts: data.plan.startingCash.breakdown
          .filter(r => r.id.startsWith('chequing')).map(r => ({ ...r, evidenceDate: x.asOf })) } };
      const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(10000);
      await page.addInitScript(() => localStorage.setItem('hfd-plan-knobs-v1', JSON.stringify({ weeklyVariable: 0 })));
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://savings-roster.test') { external.push(url.origin); return route.abort(); }
        if (route.request().method() !== 'GET') { writes.push(route.request().method()); return route.abort(); }
        if (url.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return route.fulfill({ json: null });
        const file = path.resolve(assets, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
        if (!file.startsWith(assets + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        const body = fs.readFileSync(file); served[path.relative(root, file).replaceAll('\\', '/')] = crypto.createHash('sha256').update(body).digest('hex');
        return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      });
      await page.goto('http://savings-roster.test/');
      const tile = page.locator('[data-budget-savings-goals]'); await tile.waitFor();
      const current = await tile.innerText(), before = await page.evaluate(() => JSON.stringify(App.data));
      await step(page, 1);
      assert.equal(await page.locator('[data-budget-window-progress]').getAttribute('data-start'), '2026-10-16');
      const first = await tile.innerText();
      assert.doesNotMatch(first, /Invented early installment|Invented boundary installment/i);
      assert.match(first, /Invented next installment/i); assert.match(first, /40\.00/);
      if (mode !== 'ready') assert.match(first, /Savings at period close: Unavailable/);
      await (async t => { const p = t.locator('.blend-goals-panel'); if (await p.count() && !(await p.evaluate(n => n.open))) await t.locator('.blend-tile-head').click(); })(tile); // Refined face: Accounts & evidence opens from the savings detail.
      await tile.locator('[data-budget-funding-inventory]').focus(); await page.keyboard.press('Enter');
      const dialog = page.locator('[data-budget-detail-sheet]'); await dialog.waitFor({ state: 'visible' });
      const info = dialog.locator('[data-budget-savings-info] > summary');
      if (!await info.evaluate(n => n.parentElement.open)) await info.click();
      const inventory = await dialog.locator('[data-savings-inventory]').innerText();
      assert.doesNotMatch(inventory, /Invented early installment|Invented boundary installment/i);
      assert.match(inventory, /Invented next installment/i);
      await dialog.screenshot({ path: path.join(out, mode + '-' + width + '.png'), animations: 'disabled' });
      await page.keyboard.press('Escape');
      await step(page, 1); const second = await tile.innerText();
      assert.doesNotMatch(second, /Invented .*installment/i); assert.match(second, /Invented later goal/i);
      await step(page, 1); assert.match(await tile.innerText(), /No remaining Savings requirements/);
      await step(page, -1); assert.equal(await tile.innerText(), second);
      await step(page, -1); assert.equal(await tile.innerText(), first);
      await step(page, -1); assert.equal(await tile.innerText(), current);
      await page.evaluate(() => App.rerender()); assert.equal(await tile.innerText(), current);
      assert.equal(await page.evaluate(() => JSON.stringify(App.data)), before);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      cases.push({ width, mode, first, second, inventory, inclusive: true, replay: true, currentRestored: true, immutable: true });
      console.log('PASS ' + mode + ' ' + width); await page.close();
    }
  } finally { await browser.close(); }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(writes, []);
  const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(out, 'proof.json'), JSON.stringify({ head, synthetic: true, served, cases, errors, external, writes }, null, 2) + '\n');
})().catch(e => { console.error(e); process.exitCode = 1; });
