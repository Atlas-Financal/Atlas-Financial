'use strict';
// Browser proof for Budget's reviewed #605 compact toolbar: 44px controls,
// 24px glyphs, accessible light/dark switching and the existing hfd-theme
// preference. Keep the original Auto + OS-light empty-glyph regression and
// every OS/stored-theme combination; other pages retain their labelled cycle.
//
//   CHROME_PATH=<Chromium> node test/browser-theme-control.js
//   THEME_ROOT=<checkout> — serve that tree instead.
//   THEME_BASE_ROOT=<pristine base checkout> — also record its Auto + OS-light
//     header, unasserted, as explicitly labelled before-state evidence.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const serveRoot = process.env.THEME_ROOT || root;
const baseRoot = process.env.THEME_BASE_ROOT || null;
const isServeTree = path.resolve(serveRoot) === path.resolve(root);
const outDir = path.join(root, 'docs', 'proof');
const fx = require('./fixtures/budget-surface-data');
const data = fx.served();

const CLAIM = 'the Budget header has one accessible 44px theme control with exactly one visible 24px glyph in every OS/stored-theme state at 390px, 320px and desktop widths; mouse clicks, touch taps and keyboard activation switch directly between light and dark and persist hfd-theme; the original empty-glyph regression and bills labelled theme control remain protected';

const blobSha = file => {
  const bytes = fs.readFileSync(file);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};
const sha256File = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function openPage(browser, serveDir, { width, height, colorScheme, stored, hasTouch = false }) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme, hasTouch });
  if (stored) {
    await context.addInitScript(value => {
      try { localStorage.setItem('hfd-theme', value); } catch (e) {}
    }, stored);
  }
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', intercepted => {
    const url = new URL(intercepted.request().url());
    if (url.origin !== 'http://theme.test') return intercepted.abort();
    if (url.pathname === '/data.json') return intercepted.fulfill({ json: data });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) {
      return intercepted.fulfill({ json: null });
    }
    if (url.pathname === '/talk/capability') return intercepted.fulfill({ json: { available: false } });
    if (url.pathname === '/talk/context') return intercepted.fulfill({ status: 404, body: '' });
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(serveDir, 'public', rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return intercepted.fulfill({ status: 404, body: '' });
    const body = fs.readFileSync(file);
    const type = file.endsWith('.css') ? 'text/css'
      : file.endsWith('.js') ? 'application/javascript'
      : file.endsWith('.woff2') ? 'font/woff2'
      : file.endsWith('.png') ? 'image/png'
      : 'text/html';
    return intercepted.fulfill({ body, contentType: type });
  });
  return { context, page, errors };
}

const glyphProbe = () => {
  const probe = sel => {
    const el = document.querySelector(sel);
    if (!el) return { present: false, display: null, width: 0, height: 0, visible: false };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      present: true,
      display: cs.display,
      width: r.width,
      height: r.height,
      visible: cs.display !== 'none' && r.width > 0 && r.height > 0,
    };
  };
  const btn = document.querySelector('[data-blend-theme]');
  const br = btn ? btn.getBoundingClientRect() : { width: 0, height: 0 };
  return {
    dataTheme: document.documentElement.getAttribute('data-theme'),
    stored: (() => { try { return localStorage.getItem('hfd-theme'); } catch (e) { return null; } })(),
    button: { width: br.width, height: br.height, tag: btn?.tagName, type: btn?.type,
      name: btn?.getAttribute('aria-label'), count: document.querySelectorAll('[data-blend-theme]').length },
    moon: probe('[data-blend-theme] .i-moon'),
    sun: probe('[data-blend-theme] .i-sun'),
  };
};

async function bootBudget(browser, serveDir, opts) {
  const { context, page, errors } = await openPage(browser, serveDir, opts);
  await page.goto('http://theme.test/');
  await page.waitForSelector('[data-budget-bento]', { state: 'attached' });
  await sleep(150);
  const measured = await page.evaluate(glyphProbe);
  return { context, page, errors, measured };
}

function assertState(row, expectedGlyph, label) {
  const other = expectedGlyph === 'moon' ? 'sun' : 'moon';
  assert.equal(row.measured[expectedGlyph].visible, true,
    `${label}: ${expectedGlyph} glyph is visible (display=${row.measured[expectedGlyph].display}, box=${row.measured[expectedGlyph].width}x${row.measured[expectedGlyph].height})`);
  assert.ok(row.measured[expectedGlyph].width >= 23 && row.measured[expectedGlyph].width <= 25
    && row.measured[expectedGlyph].height >= 23 && row.measured[expectedGlyph].height <= 25,
    `${label}: ${expectedGlyph} glyph box is 24x24 (got ${row.measured[expectedGlyph].width}x${row.measured[expectedGlyph].height})`);
  assert.equal(row.measured[other].visible, false, `${label}: ${other} glyph is not visible`);
  assert.equal(row.measured[other].display, 'none', `${label}: ${other} glyph computes display:none`);
  assert.equal(row.measured.button.width, 44, `${label}: button box is 44 wide`);
  assert.equal(row.measured.button.height, 44, `${label}: button box is 44 high`);
  assert.equal(row.measured.button.count, 1, `${label}: one theme control`);
  assert.equal(row.measured.button.tag, 'BUTTON', `${label}: semantic button`);
  assert.equal(row.measured.button.type, 'button', `${label}: non-submit control`);
  assert.equal(row.measured.button.name, expectedGlyph === 'sun' ? 'Switch to light theme' : 'Switch to dark theme',
    `${label}: accessible name describes the next theme`);
  assert.deepEqual(row.errors, [], `${label}: no page errors`);
}

(async () => {
  assert.ok(process.env.CHROME_PATH, 'CHROME_PATH must name the Chromium executable.');
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const runtime = { node: process.version, chromium: await browser.version(), platform: process.platform };
  const states = [];
  try {
    // Core matrix: the four theme states at 390, 320 and a desktop width.
    const widths = [
      { width: 390, height: 844, label: '390' },
      { width: 320, height: 700, label: '320' },
      { width: 1440, height: 900, label: 'desktop' },
    ];
    const cases = [
      { name: 'auto + OS light', colorScheme: 'light', stored: null, expect: 'moon', expectTheme: null },
      { name: 'auto + OS dark', colorScheme: 'dark', stored: null, expect: 'sun', expectTheme: null },
      { name: 'stored dark', colorScheme: 'light', stored: 'dark', expect: 'sun', expectTheme: 'dark' },
      { name: 'stored light', colorScheme: 'light', stored: 'light', expect: 'moon', expectTheme: 'light' },
    ];
    for (const w of widths) {
      for (const c of cases) {
        const row = await bootBudget(browser, serveRoot, { ...w, colorScheme: c.colorScheme, stored: c.stored });
        const label = `${c.name} @ ${w.label}`;
        assert.equal(row.measured.dataTheme, c.expectTheme, `${label}: data-theme is ${c.expectTheme}`);
        assertState(row, c.expect, label);
        states.push({ state: c.name, width: w.label, ...row.measured, errors: row.errors });
        await row.context.close();
      }
    }
    // Cross-scheme explicit states (390 only): an explicit stored theme
    // must beat the OS-scheme media rules in both directions.
    for (const c of [
      { name: 'stored dark + OS dark', colorScheme: 'dark', stored: 'dark', expect: 'sun', expectTheme: 'dark' },
      { name: 'stored light + OS dark', colorScheme: 'dark', stored: 'light', expect: 'moon', expectTheme: 'light' },
    ]) {
      const row = await bootBudget(browser, serveRoot, { width: 390, height: 844, colorScheme: c.colorScheme, stored: c.stored });
      assert.equal(row.measured.dataTheme, c.expectTheme, `${c.name}: data-theme is ${c.expectTheme}`);
      assertState(row, c.expect, c.name);
      states.push({ state: c.name, width: '390', ...row.measured, errors: row.errors });
      await row.context.close();
    }

    // Preserve the original mouse-click sequence from Auto + OS light at390.
    // The third click distinguishes reviewed binary switching from the old Auto cycle.
    const tap = await bootBudget(browser, serveRoot, { width: 390, height: 844, colorScheme: 'light', stored: null });
    assertState(tap, 'moon', 'tap sequence start (auto + OS light)');
    await tap.page.click('[data-blend-theme]');
    await sleep(150);
    let m = await tap.page.evaluate(glyphProbe);
    assert.equal(m.dataTheme, 'dark', 'tap 1: data-theme becomes dark');
    assert.equal(m.stored, 'dark', 'tap 1: hfd-theme persists dark');
    assert.equal(m.sun.visible, true, 'tap 1: sun glyph visible');
    assert.equal(m.moon.display, 'none', 'tap 1: moon glyph hidden');
    await tap.page.click('[data-blend-theme]');
    await sleep(150);
    m = await tap.page.evaluate(glyphProbe);
    assert.equal(m.dataTheme, 'light', 'tap 2: data-theme becomes light');
    assert.equal(m.stored, 'light', 'tap 2: hfd-theme persists light');
    assert.equal(m.moon.visible, true, 'tap 2: moon glyph visible');
    assert.equal(m.sun.display, 'none', 'tap 2: sun glyph hidden');
    await tap.page.reload();
    await tap.page.waitForSelector('[data-budget-bento]', { state: 'attached' });
    await sleep(150);
    m = await tap.page.evaluate(glyphProbe);
    assert.equal(m.dataTheme, 'light', 'reload: stored light still applies');
    assert.equal(m.moon.visible, true, 'reload: moon glyph visible for stored light');
    assert.deepEqual(tap.errors, [], 'tap sequence: no page errors');
    await tap.page.click('[data-blend-theme]');
    await sleep(150);
    m = await tap.page.evaluate(glyphProbe);
    assert.equal(m.dataTheme, 'dark', 'click 3: binary control returns to dark, not Auto');
    assert.equal(m.stored, 'dark', 'click 3: hfd-theme persists dark');
    assertState({ measured: m, errors: tap.errors }, 'sun', 'third mouse click');
    const mouseResult = { sequence: 'auto -> dark -> light -> reload -> dark', persistedVia: 'hfd-theme', finalState: m };
    await tap.context.close();

    // Real keyboard and touch activation start from both effective OS themes.
    // Keep click/tap/press distinct so one input path cannot stand in for another.
    const interactions = [];
    for (const input of ['keyboard', 'touch']) for (const colorScheme of ['light', 'dark']) {
      const row = await bootBudget(browser, serveRoot, {
        width: 390, height: 844, colorScheme, stored: null, hasTouch: input === 'touch',
      });
      const button = row.page.locator('[data-blend-theme]');
      assertState(row, colorScheme === 'dark' ? 'sun' : 'moon', `${input} start, OS ${colorScheme}`);
      if (input === 'keyboard') await button.focus();
      for (let step = 0; step < 2; step++) {
        if (input === 'touch') await button.tap();
        else await row.page.keyboard.press(step === 0 ? 'Enter' : 'Space');
        await sleep(150);
        const theme = step === 0 ? (colorScheme === 'dark' ? 'light' : 'dark') : colorScheme;
        const measured = await row.page.evaluate(glyphProbe);
        assert.equal(measured.dataTheme, theme, `${input} step${step + 1}: explicit ${theme}`);
        assert.equal(measured.stored, theme, `${input} step${step + 1}: preference persists`);
        assertState({ measured, errors: row.errors }, theme === 'dark' ? 'sun' : 'moon',
          `${input} step${step + 1}, OS ${colorScheme}`);
        if (input === 'keyboard') assert.equal(await button.evaluate(el => el === document.activeElement), true,
          'keyboard activation retains the exact theme button focus');
        interactions.push({ input, colorScheme, step: step + 1, measured });
      }
      await row.context.close();
    }

    // Control: bills.html's labelled #theme-btn, unchanged behaviour.
    const bills = await openPage(browser, serveRoot, { width: 390, height: 844, colorScheme: 'light', stored: null });
    await bills.page.goto('http://theme.test/bills.html');
    await bills.page.waitForSelector('#theme-btn', { state: 'attached' });
    await sleep(150);
    const btnState = () => bills.page.evaluate(() => {
      const b = document.getElementById('theme-btn');
      const r = b.getBoundingClientRect();
      return {
        text: b.textContent.trim(),
        width: r.width, height: r.height,
        visible: r.width > 0 && r.height > 0 && getComputedStyle(b).display !== 'none',
        dataTheme: document.documentElement.getAttribute('data-theme'),
      };
    });
    const before = await btnState();
    assert.equal(before.visible, true, 'bills control: #theme-btn visible at 390');
    assert.equal(before.text, 'Theme: Auto', 'bills control: initial label is Theme: Auto');
    await bills.page.click('#theme-btn');
    await sleep(150);
    const after = await btnState();
    assert.equal(after.text, 'Theme: Dark', 'bills control: click cycles label to Theme: Dark');
    assert.equal(after.dataTheme, 'dark', 'bills control: click sets data-theme dark');
    assert.deepEqual(bills.errors, [], 'bills control: no page errors');
    const billsResult = { before, after };
    await bills.context.close();

    // Screenshots + before-state evidence (receipt-writing runs only).
    let beforeState = null;
    const screenshots = [];
    if (isServeTree) {
      fs.mkdirSync(outDir, { recursive: true });
      const shot = await bootBudget(browser, serveRoot, { width: 390, height: 844, colorScheme: 'light', stored: null });
      const headerBox = await shot.page.evaluate(() => {
        const h = document.querySelector('header');
        const r = h.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      const afterFile = path.join(outDir, 'theme-control-header-auto-light-390.png');
      await shot.page.screenshot({ path: afterFile, clip: headerBox });
      screenshots.push({ file: 'docs/proof/theme-control-header-auto-light-390.png', sha256: sha256File(afterFile), state: 'after (this tree), auto + OS light, 390px header' });
      await shot.context.close();
      if (baseRoot) {
        const base = await bootBudget(browser, baseRoot, { width: 390, height: 844, colorScheme: 'light', stored: null });
        beforeState = { root: 'THEME_BASE_ROOT (pristine base)', ...base.measured, errors: base.errors };
        const baseHeaderBox = await base.page.evaluate(() => {
          const h = document.querySelector('header');
          const r = h.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        });
        const beforeFile = path.join(outDir, 'theme-control-header-auto-light-390-before.png');
        await base.page.screenshot({ path: beforeFile, clip: baseHeaderBox });
        screenshots.push({ file: 'docs/proof/theme-control-header-auto-light-390-before.png', sha256: sha256File(beforeFile), state: 'before (pristine base), auto + OS light, 390px header' });
        await base.context.close();
      }
      const receipt = {
        proof: 'browser-theme-control',
        claim: CLAIM,
        runtime,
        servedSources: Object.fromEntries([
          'public/budget-blend.css', 'public/atlas-toolbar.css', 'public/index.html', 'public/budget-blend.js',
          'public/app.js', 'public/bills.html', 'test/browser-theme-control.js',
        ].map(rel => [rel, blobSha(path.join(root, rel))])),
        states,
        mouse: mouseResult,
        interactions,
        billsControl: billsResult,
        beforeState,
        screenshots,
      };
      fs.writeFileSync(path.join(outDir, 'theme-control-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    }
    console.log(`PASS theme control: ${states.length} state rows (exactly one glyph each), binary mouse/touch/keyboard switching persisted via hfd-theme; mouse reload preserved it, bills #theme-btn control unchanged, zero page errors`);
  } finally {
    await browser.close();
  }
})().catch(err => { console.error(err); process.exit(1); });
