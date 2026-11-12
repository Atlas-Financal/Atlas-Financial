'use strict';
// Actual Budget App.boot/Forecast renderer. Invented observer/overlay packets.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { assertTypedBillFilters } = require('./helpers/typed-bill-filter-proof');
const fixture = require('./fixtures/paid-actual-display-trust');
const root = process.env.ATLAS_PAID_ACTUAL_ROOT || path.join(__dirname, '..');
const out = process.env.ATLAS_PAID_ACTUAL_SCREENSHOTS_DIR || path.join(require('node:os').tmpdir(), 'paid-actual-trust');
const before = process.argv.includes('--before'); fs.mkdirSync(out, { recursive: true });
const head = execFileSync('git', ['-c', 'safe.directory=' + root.split(path.sep).join('/'), 'rev-parse', 'HEAD'],
  { cwd: root, encoding: 'utf8' }).trim();
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const errors = [], external = [], results = [];
  try { for (const width of [1440, 390, 320]) {
    let data = fixture.served();
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.origin !== 'http://paid.test') { external.push(u.origin); return route.abort(); }
      if (u.pathname === '/data.json') return route.fulfill({ json: data });
      if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
      const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js')
        ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    const boot = async () => { await page.goto('http://paid.test/'); await page.locator('[data-budget-surface]').waitFor(); };
    // The period pill was retired; the native step control remains the
    // period control behind the river (as browser-budget-house-bars.js uses).
    const changePeriod = async direction => {
      const step = direction === 'ArrowLeft' ? '-1' : '1';
      const before = await page.evaluate(() => [...document.querySelectorAll('[data-budget-window-range]')].map(e => e.textContent).join('|'));
      await page.evaluate(dir => { const b = [...document.querySelectorAll(`[data-budget-window-step="${dir}"]`)].find(x => x.getAttribute('aria-disabled') !== 'true');
        if (!b) throw Error('no period step ' + dir); b.click(); }, step);
      await page.waitForFunction(was => [...document.querySelectorAll('[data-budget-window-range]')].map(e => e.textContent).join('|') !== was, before);
    };
    // #548 moved the roster off-screen: the visible Bills tile lists each
    // occurrence once (data-blend-bill = id:date) and opens the same sheet.
    const bill = id => page.locator(`[data-blend-bill^="${id}:"]`);
    const billsOpen = page.locator('[data-blend-bills-open]');
    const roster = page.locator('[data-budget-detail-sheet] [data-blend-bills-panel]');
    const inspect = async (id, amount, name, estimated) => {
      const trigger = bill(id), text = await trigger.innerText();
      assert.match(text, new RegExp(amount));
      if (estimated) assert.match(text, /estimated/); else assert.doesNotMatch(text, /estimated|≈|about/);
      await trigger.focus(); await page.keyboard.press('Enter');
      const sheet = page.locator('[data-budget-detail-body]'), summary = sheet.locator('[data-period-bill]');
      const summaryText = await summary.innerText();
      if (estimated) assert.match(summaryText, /about/); else assert.doesNotMatch(summaryText, /about|≈|estimated/);
      assert.match(await sheet.innerText(), /Payment evidence/);
      if (name !== 'future') assert.match(await sheet.innerText(), /Posted|Pending [—-] not a posted payment|evidence is unavailable/);
      await page.screenshot({ path: path.join(out, `${name}-sheet-${width}.png`), animations: 'disabled' });
      await page.keyboard.press('Escape');
      assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
      await page.locator('[data-budget-browse="bills"]').screenshot({ path: path.join(out, `${name}-rows-${width}.png`), animations: 'disabled' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      results.push({ width, name, text, summaryText, focusRestored: true, noOverflow: true });
    };
    await boot();
    const inputBefore = await page.evaluate(() => JSON.stringify(App.data));
    await inspect('invented-current-utility', '61\\.27', 'current', before);
    await changePeriod('ArrowLeft');
    await billsOpen.click(); await page.locator('[data-budget-detail-sheet]').waitFor({ state: 'visible' });
    const paid = roster.locator('[data-budget-bill-filter="paid"]'); await paid.focus(); await page.keyboard.press('Enter');
    assert.deepEqual(await roster.locator('[data-budget-bill-bucket]:visible [data-budget-bill-open]').evaluateAll(rows => rows.map(row => row.getAttribute('data-budget-bill-open') + '@' + row.getAttribute('data-budget-bill-date'))), ['invented-past-utility@2026-08-07']);
    await page.keyboard.press('Escape');
    await inspect('invented-past-utility', '59\\.83', 'history', before);
    await billsOpen.click(); await page.locator('[data-budget-detail-sheet]').waitFor({ state: 'visible' });
    await assertTypedBillFilters(page, roster, {
      paid: ['invented-past-utility@2026-08-07'], check: [], due: [], pending: [], unknown: [],
    });
    await page.keyboard.press('Escape');
    await changePeriod('ArrowRight'); await changePeriod('ArrowRight');
    await inspect('invented-past-utility', '183\\.61', 'future', true);
    assert.equal(await page.evaluate(() => JSON.stringify(App.data)), inputBefore, 'navigation leaves the served packet unchanged');
    const currentReceipt = p => p.transactions.find(t => t.id ===
      p.representedActuals.find(r => r.id === 'invented-current-utility').transactionId);
    if (!before) for (const [name, change] of [
      ['pending', p => { currentReceipt(p).pending = true; }],
      ['missing', p => { delete p.representedActuals.find(r => r.id === 'invented-current-utility').transactionId; }],
      ['conflict', p => { p.transactions.push({ ...currentReceipt(p), amount: 99 }); }],
      ['unknown-coverage', p => { p.transactionCoverage = 'unknown'; }],
      ['partial-coverage', p => { p.transactionCoverage = 'partial'; }],
      ['missing-coverage', p => { delete p.transactionCoverage; }],
    ]) {
      data = fixture.served(); change(data.liveOverlay.currentPeriodActuals);
      await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await boot();
      await inspect('invented-current-utility', '61\\.27', name, true);
    }
    if (!before) for (const [name, units, estimated] of [
      ['replacement-currency-conflict', 'usd', true], ['replacement-native', 'cad', false],
    ]) {
      data = fixture.replacement(units);
      const packet = data.liveOverlay.currentPeriodActuals;
      const claim = packet.representedActuals.find(r => r.id === 'invented-current-utility');
      const receipt = packet.transactions.find(t => t.id === claim.transactionId);
      assert.equal(receipt.currency, 'cad'); assert.equal(receipt.pending, false);
      assert.equal(receipt.coverageCurrencyConflict, estimated);
      assert.deepEqual(packet.currencyUnconfirmed, []);
      await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await boot();
      await inspect('invented-current-utility', '61\\.27', name, estimated);
    }
    await page.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ head, before, syntheticOnly: true, results, errors, external }, null, 2) + '\n');
  console.log(`PASS ${head}: actual Budget current/history/future${before ? ' baseline' : ', pending/missing/conflicting, unknown/partial/missing coverage and native/conflicting replacement chains'}, both bill summaries, keyboard filters/focus and overflow at 1440/390/320`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
