'use strict';
// Optional real Budget proof. Every response is invented/intercepted; the save
// picker is replaced only in this synthetic page. No live session or OS file.
// NODE_PATH=<playwright> CHROME_PATH=<Chromium> node test/browser-private-comparison-download.js
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');
const root = path.join(__dirname, '..'), origin = 'http://localhost:39127';
const checkedAt = '2038-06-06T18:00:00.000Z';
async function fingerprint(page) {
  return page.locator('#operating-surface-body').evaluate(node => {
    const copy = node.cloneNode(true);
    copy.querySelector('[data-budget-detail-sheet]')?.remove();
    return { text: copy.textContent.replace(/\s+/g, ' ').trim(),
      selections: [...node.querySelectorAll('select')].map(el => el.value) };
  });
}
async function open(browser, mode, width) {
  const input = { data: fx.served(), periods: { asOf: '2026-08-19', periods: {}, monthly: [], unknown: null },
    history: { schema: 'atlas-balance-history/v1', snapshots: [], unknown: null } };
  const requests = [], errors = [], page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
  page.on('pageerror', err => errors.push(err.message));
  await page.addInitScript(chosen => {
    globalThis.privateSaveProof = { writes: [], operations: [], calls: 0, mode: chosen, forecastCalls: 0 };
    if (chosen === 'unsupported') { globalThis.showSaveFilePicker = undefined; return; }
    globalThis.showSaveFilePicker = async () => {
      const proof = globalThis.privateSaveProof; proof.calls++; proof.operations.push('picker');
      if (proof.mode === 'cancel') throw new DOMException('Synthetic cancellation', 'AbortError');
      return { async createWritable() { proof.operations.push('createWritable'); return {
        async write(body) { proof.operations.push('write'); proof.writes.push(body); if (proof.mode === 'write-failure') throw Error('Synthetic write failure'); },
        async close() { proof.operations.push('close'); if (proof.mode === 'close-failure') throw Error('Synthetic close failure'); },
        async abort() { proof.operations.push('abort'); },
      }; } };
    };
  }, mode);
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    requests.push({ origin: u.origin, path: u.pathname, method: route.request().method() });
    assert.equal(u.origin, origin, 'synthetic local origin only');
    assert.equal(route.request().method(), 'GET', 'no household/provider writes');
    if (u.pathname === '/data.json') return route.fulfill({ json: input.data, headers: {
      'X-Atlas-Observation-Source': 'memory', 'X-Atlas-Observation-Qualified': 'true', 'X-Atlas-Observation-Checked-At': checkedAt,
    } });
    if (u.pathname === '/periods.json') return route.fulfill({ json: input.periods });
    if (u.pathname === '/balance-history.json') return mode === 'missing-history'
      ? route.fulfill({ status: 503, json: { error: 'synthetic unavailable' } }) : route.fulfill({ json: input.history });
    const file = path.resolve(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
    assert.ok(file.startsWith(path.join(root, 'public') + path.sep));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404 });
    let body = fs.readFileSync(file);
    if (u.pathname === '/' || u.pathname === '/index.html') body = body.toString().replace('Running build unavailable', 'Running commit abcdef0');
    return route.fulfill({ body, contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'text/html' });
  });
  await page.goto(origin);
  await page.locator('[data-budget-surface]').waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-boot-notice]'));
  // Count only calls caused by the action, after the real fixture boot.
  await page.evaluate(() => {
    for (const key of Object.keys(Forecast)) if (typeof Forecast[key] === 'function') {
      const fn = Forecast[key]; Forecast[key] = function(...args) { privateSaveProof.forecastCalls++; return fn.apply(this, args); };
    }
  });
  assert.deepEqual(errors, []);
  return { page, input, requests, errors };
}
async function saveAndCheck(state, expected, mode) {
  const { page, requests, input } = state;
  const before = await fingerprint(page);
  await page.locator('[data-transaction-review-open]').click();
  const button = page.locator('[data-private-comparison-save]'), status = page.locator('[data-private-comparison-status]');
  assert.equal(await button.count(), 1, 'single existing-sheet control');
  await page.evaluate(() => { privateSaveProof.forecastCalls = 0; });
  const count = requests.length;
  if (mode === 'unsupported' || mode === 'missing-history') {
    assert.equal(await button.isDisabled(), true);
    assert.match(await status.innerText(), mode === 'unsupported' ? /unavailable in this browser/ : /incomplete/);
  } else {
    await button.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(text => document.querySelector('[data-private-comparison-status]').textContent.includes(text), expected);
  }
  assert.equal(requests.length, count, 'save action performs zero network requests');
  const proof = await page.evaluate(() => privateSaveProof);
  assert.equal(proof.forecastCalls, 0, 'save action performs zero Forecast calls');
  if (mode === 'success') {
    assert.deepEqual(proof.operations.slice(-4), ['picker', 'createWritable', 'write', 'close']);
    const payload = JSON.parse(proof.writes.at(-1));
    assert.deepEqual(payload.inputs, input, 'exact successful source JSON in real browser save');
    assert.equal(payload.provenance.observation.checkedAt, checkedAt);
    assert.equal(payload.provenance.pageBuildLabel, 'Running commit abcdef0');
    assert.equal(payload.provenance.dataServingRevision, null);
  } else if (mode === 'cancel' || mode === 'unsupported' || mode === 'missing-history') assert.deepEqual(proof.writes, []);
  else assert.ok(proof.operations.includes('abort'), 'failed stream is aborted');
  await page.locator('[data-review-return]').click();
  assert.deepEqual(await fingerprint(page), before, 'all period/month labels, values and selections remain unchanged');
  assert.equal(await page.locator('[data-transaction-review-open]').evaluate(node => node === document.activeElement), true, 'existing sheet returns focus to its trigger');
  assert.deepEqual(state.errors, []);
}
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  let journeys = 0;
  try {
    for (const width of [390, 1440]) {
      const state = await open(browser, 'success', width), { page } = state;
      await saveAndCheck(state, 'inputs saved', 'success'); journeys++;
      await page.locator('[data-blend-figures-open]').click();
      await page.keyboard.press('Escape');
      await saveAndCheck(state, 'inputs saved', 'success'); journeys++;
      await page.locator('[data-blend-figures-open]').click();
      await page.keyboard.press('Escape');
      await saveAndCheck(state, 'inputs saved', 'success'); journeys++;
      await page.emulateMedia({ colorScheme: 'dark' });
      assert.equal(await page.locator('[data-private-comparison-save]').count(), 1, 'native rerender retains one control');
      await page.close();
    }
    for (const mode of ['cancel', 'write-failure', 'close-failure', 'unsupported', 'missing-history']) {
      const state = await open(browser, mode, 390);
      await saveAndCheck(state, mode === 'cancel' ? 'cancelled' : 'No completed save was confirmed', mode); journeys++;
      await state.page.close();
    }
    console.log(`PASS private comparison browser: ${journeys} synthetic Budget/sheet journeys; period/month parity, keyboard save/return focus, exact JSON, success/cancel/failure/unsupported/missing states, no extra network or Forecast; ${browser.version()}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
