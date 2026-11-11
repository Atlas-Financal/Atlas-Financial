'use strict';
// ATLAS-067: real documents and shared boot, synthetic inputs only.
// NODE_PATH=<Playwright install>/node_modules CHROME_PATH=<Chromium>
//   node test/browser-startup-feedback.js
// STARTUP_ROOT=<pristine checkout> supports the before control.
// STARTUP_STATIC_ONLY=1 runs the pre-script accessibility regression alone.
// Receipts/screenshots default outside git; STARTUP_OUT selects their directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const root = process.env.STARTUP_ROOT || path.join(__dirname, '..');
const out = process.env.STARTUP_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-startup-proof-'));
fs.mkdirSync(out, { recursive: true });
const data = require('./fixtures/budget-surface-data').served();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const longMs = 60000;
const receipt = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  syntheticOnly: true, delayMs: longMs, scenarios: {}, screenshots: {}, assets: {} };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const gate = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };
let browser;
async function pageFor(routePath, plan, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...options.context });
  const page = await context.newPage();
  let calls = 0;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://startup.test') return route.abort();
    if (url.pathname === '/data.json') {
      const response = await plan(++calls, url);
      try { return await route.fulfill({ status: response.status || 200, json: response.status ? { error: 'Synthetic unavailable' } : data }); }
      catch { return; } // A cancelled synthetic request has no live consumer.
    }
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return route.fulfill({ json: null });
    if (url.pathname === '/talk/capability') return route.fulfill({ json: { available: false } });
    if (url.pathname.startsWith('/talk/')) return route.fulfill({ status: 404, body: '' });
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(root, 'public', rel);
    if (!file.startsWith(path.resolve(root, 'public') + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    if (rel.endsWith('.js') && options.scripts) await options.scripts.promise;
    const body = fs.readFileSync(file);
    receipt.assets[rel] = hash(body);
    const contentType = rel.endsWith('.js') ? 'application/javascript' : rel.endsWith('.css') ? 'text/css' : rel.endsWith('.woff2') ? 'font/woff2' : 'text/html';
    try { return await route.fulfill({ body, contentType }); } catch { return; }
  });
  const start = Date.now();
  await page.goto('http://startup.test' + routePath, { waitUntil: 'commit' });
  return { page, context, start, calls: () => calls };
}
async function shot(page, name) {
  const file = path.join(out, name + '.png');
  await page.screenshot({ path: file });
  receipt.screenshots[name] = hash(fs.readFileSync(file));
}
async function isolated(page, staticPhase = false) {
  const state = await page.evaluate(staticPhase => {
    const n = document.querySelector('[data-boot-notice], [data-boot-static]');
    const wrap = document.querySelector('.wrap');
    const shell = [...document.body.children].flatMap(el => el === wrap ? [...el.children] : [el])
      .filter(el => el !== n && el.tagName !== 'SCRIPT');
    // The empty tooltip mount has no accessible content before scripts run.
    const uncovered = shell.filter(el => !(el.id === 'tip' && !el.textContent.trim())
      && !el.closest('[inert]') && !el.closest('[aria-hidden="true"]'));
    const r = n.getBoundingClientRect();
    return { shellCount: shell.length, uncovered: uncovered.map(el => el.id || el.className),
      fullScreen: r.x === 0 && r.y === 0 && r.width === innerWidth && r.height === innerHeight,
      progressBars: document.querySelectorAll('[role="progressbar"]').length,
      notice: n.innerText, staticPhase };
  }, staticPhase);
  assert.ok(state.shellCount > 3);
  assert.deepEqual(state.uncovered, [], 'covered content stays inaccessible');
  assert.equal(state.fullScreen, true);
  assert.equal(state.progressBars, 0, 'indeterminate loading makes no percentage claim');
  return state;
}
async function ready(page) {
  await page.waitForFunction(() => typeof App !== 'undefined' && App.data
    && !document.querySelector('[data-boot-notice], [data-boot-static]'), null, { timeout: 45000 });
  assert.equal(await page.locator('[data-boot-static], [data-boot-inert]').count(), 0);
  assert.equal(await page.locator('.site-head').getAttribute('inert'), null);
  assert.deepEqual(await page.evaluate(() => App.data), data, 'successful boot preserves the entire synthetic packet');
}
async function staticFeedback() {
  const scripts = gate();
  const s = await pageFor('/', async () => ({}), { scripts });
  try {
    await s.page.locator('[data-boot-static]').waitFor();
    const ax = await s.page.locator('body').ariaSnapshot();
    fs.writeFileSync(path.join(out, 'pre-script-accessibility.txt'), ax);
    await shot(s.page, 'pre-script');
    assert.match(ax, /status:[\s\S]*Loading Atlas/, 'pre-script loading text must be exposed as an accessible status');
    await isolated(s.page, true);
    const firstFeedbackMs = Date.now() - s.start;
    if (!process.env.STARTUP_STATIC_ONLY) {
      await pause(Math.max(0, longMs - (Date.now() - s.start)));
      assert.match(await s.page.locator('body').ariaSnapshot(), /Loading Atlas/);
      scripts.release();
      await ready(s.page);
      assert.equal(s.calls(), 1);
    }
    receipt.scenarios.static = { firstFeedbackMs, accessibleStatus: true, handoff: !process.env.STARTUP_STATIC_ONLY };
  } finally { scripts.release(); await s.context.close(); }
}
async function delayedRoute(routePath, delayMs, reduced = false) {
  const s = await pageFor(routePath, async () => { await pause(delayMs); return {}; },
    { context: reduced ? { reducedMotion: 'reduce', viewport: { width: 320, height: 700 } } : {} });
  const name = routePath === '/' ? 'budget' : path.basename(routePath, '.html');
  try {
    await s.page.getByRole('button', { name: 'Cancel', exact: true }).waitFor();
    const firstFeedbackMs = Date.now() - s.start;
    assert.match(await s.page.locator('body').ariaSnapshot(), /Loading current data/);
    await isolated(s.page);
    if (reduced) assert.equal(await s.page.locator('[data-boot-notice] .boot-mark-a').evaluate(el => getComputedStyle(el).animationName), 'none');
    if (delayMs === longMs) {
      await pause(Math.max(0, 55000 - (Date.now() - s.start)));
      await isolated(s.page);
      await shot(s.page, name + '-55-seconds');
    }
    await ready(s.page);
    receipt.scenarios[name] = { firstFeedbackMs, readyMs: Date.now() - s.start, delayMs, reducedMotion: reduced, calls: s.calls() };
  } finally { await s.context.close(); }
}
async function interrupted() {
  const late = gate();
  const s = await pageFor('/bills.html', async call => {
    if (call === 1) { await late.promise; return {}; }
    await pause(400);
    return call === 2 ? { status: 503 } : {};
  });
  try {
    const cancel = s.page.getByRole('button', { name: 'Cancel', exact: true });
    await cancel.waitFor();
    await cancel.click();
    late.release();
    await s.page.waitForFunction(() => document.querySelector('[data-boot-notice]')?.textContent.startsWith('Loading cancelled. Figures remain unavailable.'));
    await isolated(s.page);
    await shot(s.page, 'cancelled');
    assert.equal(await s.page.locator('[data-boot-notice] .boot-mark-a').evaluate(el => getComputedStyle(el).animationName), 'none');
    await s.page.getByRole('button', { name: 'Retry', exact: true }).evaluate(el => { el.click(); el.click(); });
    await s.page.waitForFunction(() => document.querySelector('[data-boot-notice]')?.textContent.startsWith('Current data could not be loaded. Figures remain unavailable.'));
    assert.equal(s.calls(), 2, 'repeated Retry is single-flight');
    await isolated(s.page);
    await shot(s.page, 'failure');
    await s.page.getByRole('button', { name: 'Retry', exact: true }).click();
    await ready(s.page);
    assert.equal(s.calls(), 3);
    await shot(s.page, 'recovered-synthetic');
    receipt.scenarios.interruption = { cancelled: true, lateResponseSuppressed: true, repeatedRetrySingleFlight: true, failureVisible: true, recovered: true };
  } finally { late.release(); await s.context.close(); }
}
(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  try {
    if (process.env.STARTUP_STATIC_ONLY) await staticFeedback();
    else await Promise.all([staticFeedback(), delayedRoute('/', longMs), delayedRoute('/bills.html', longMs),
      delayedRoute('/index.html', 2500, true), interrupted()]);
    receipt.result = 'PASS';
    console.log('PASS startup feedback: ' + JSON.stringify(receipt.scenarios));
  } catch (error) {
    receipt.result = 'FAIL'; receipt.error = error.message;
    throw error;
  } finally {
    fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
    await browser.close();
    console.log('Proof artifacts: ' + out);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
