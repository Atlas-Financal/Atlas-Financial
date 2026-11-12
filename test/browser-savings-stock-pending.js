'use strict';
// Focused real current/future renderer proof, independent invented stock only.
// Optional browser proof, like browser-provider-v2-savings-stock.js; no server,
// login, provider access, canonical writes or edits to stale browser assertions.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process'), { chromium } = require('playwright');
const root = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const F = require(path.join(root, 'public/forecast'));
const fixture = require('./fixtures/planned-savings-clarity-data');
const output = process.env.ATLAS_SAVINGS_PENDING_PROOF || path.join(require('node:os').tmpdir(), 'atlas-savings-stock-pending');
const executionHead = execFileSync('git', ['-c', 'safe.directory=' + root.replace(/\\/g, '/'), 'rev-parse', 'HEAD'],
  { cwd: root, encoding: 'utf8' }).trim();
const warning = 'Pending movement evidence is unresolved.';
const dateText = text => text.replace(/ \u2013 /g, ' - ');
let checks = 0;
const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const errors = [], external = [], cases = [];
  try {
    for (const width of [1440, 390, 320]) for (const pending of [false, true])
      for (const dates of ['current', 'older', 'mixed']) for (const selection of ['future', 'current']) {
        const data = fixture(pending ? 'stock-pending' : 'backed-ready');
        const accounts = data.plan.savingsPoolObservation.accounts;
        if (dates !== 'current') accounts[0].evidenceDate = '2026-08-13';
        if (dates === 'older') accounts[1].evidenceDate = '2026-08-13';
        const before = JSON.stringify(data), stock = F.savingsInventory(data.plan, data.meta.asOf).reportedStock;
        eq(stock.status, 'ready'); eq(stock.amount, 500.03, 'independent signed stock sum 300.01 + 200.02');
        eq(stock.pendingState, pending ? 'unresolved' : 'clear');
        const label = 'Observed ' + (dates === 'current' ? '2026-08-14' : '2026-08-13')
          + (dates === 'mixed' ? ' - 2026-08-14' : '');
        const page = await browser.newPage({ viewport: { width, height: 1050 }, reducedMotion: 'reduce' });
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => {
          const url = new URL(route.request().url());
          if (url.origin !== 'http://savings-pending.test') { external.push(url.origin); return route.abort(); }
          if (url.pathname === '/data.json') return route.fulfill({ json: data });
          if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return route.fulfill({ json: null });
          const file = path.resolve(root, 'public', '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
          if (!file.startsWith(path.join(root, 'public') + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
          return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.css') ? 'text/css'
            : file.endsWith('.js') ? 'application/javascript' : 'text/html' });
        });
        await page.goto('http://savings-pending.test/');
        if (selection === 'future') await page.locator('[data-budget-window-step="1"]').first().click();
        const summary = page.locator('[data-operating-question="savings"] > details > summary');
        await summary.waitFor();
        eq((await summary.locator('.budget-step-value').innerText()).trim(), '$500.03', 'dated stock remains visible');
        eq(dateText(await summary.locator('[data-budget-savings-observed-date]').innerText()), label, 'truthful balance date/range');
        const balance = await page.locator('[data-operating-question="07"] .budget-step-value').innerText();
        if (selection === 'current' && (pending || dates !== 'current'))
          eq((await page.locator('[data-budget-funding-panel="today"] [data-budget-funding-proposal]').innerText()).trim(),
            'Unavailable', 'stock context cannot grant current funding permission');
        await summary.focus(); await page.keyboard.press('Enter');
        const body = page.locator('[data-budget-detail-body]'); await body.waitFor({ state: 'visible' });
        const info = body.locator('[data-budget-savings-info] > summary');
        await info.focus(); await page.keyboard.press('Enter');
        const note = body.locator('[data-budget-savings-stock-evidence]');
        if (selection === 'current') {
          // The daily renderer keeps its existing native warning; stock evidence
          // sits in its existing nested disclosure, opened here without a banner.
          assert.match(await body.innerText(), /Only matched settled transfers count\. Pending or unmatched movement stays unresolved\./,
            'current daily renderer retains its native pending warning'); checks++;
          await note.evaluate(el => { for (let p = el.parentElement; p; p = p.parentElement)
            if (p.tagName === 'DETAILS') p.open = true; });
        }
        eq(await note.isVisible(), true, 'stock evidence is reachable in existing Info');
        const text = await note.innerText(); eq(text.includes(warning), pending, 'stock-specific qualifier follows pending evidence');
        eq(dateText(text).includes(label), true, 'stock note retains actual dated evidence');
        eq((text.match(/Pending movement evidence is unresolved/g) || []).length, pending ? 1 : 0);
        eq(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal overflow');
        const name = [pending ? 'pending' : 'clear', dates, selection, width].join('-');
        await page.locator('[data-budget-detail-sheet]').screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' });
        await page.keyboard.press('Escape');
        eq(await summary.evaluate(el => document.activeElement === el), true, 'dismissal restores Savings focus');
        eq(await page.locator('[data-operating-question="07"] .budget-step-value').innerText(), balance, 'disclosure changes no balance');
        eq(await page.evaluate(() => JSON.stringify(App.data)), before, 'inputs unchanged');
        cases.push({ width, pending, dates, selection, stock: '$500.03', label, warningPresent: pending });
        await page.close();
        if (cases.length % 12 === 0) console.log('PASS savings pending ' + width + 'px: clear/unresolved, dated/mixed, current/future');
      }
    eq(errors, []); eq(external, []);
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ executionHead, cases, checks, errors, external,
      syntheticOnly: true, productionCredentialsUsed: false }, null, 2));
    console.log('PASS Savings pending actual renderer: ' + cases.length + ' cases / ' + checks + ' assertions');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
