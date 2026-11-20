'use strict';
// #741 (ATLAS-054) reproducer — TEST ONLY. Does a mobile Household panel open
// inside the *current* viewport, without scrolling the page upward, and does
// closing it restore the scroll position and focus?
//
// NODE_PATH=<Playwright packages> CHROME_PATH=<Chromium> node test/browser-household-panel-viewport.js
//
// Harness: the same pattern as test/browser-budget-attention-order.js and
// the retired test/browser-household-total-delta.js — real public/ assets served from this
// checkout, data.json fulfilled from the synthetic fixtures/budget-surface-data
// packet, every non-GET and every non-fixture origin aborted and counted. No
// live site, provider, credential or household evidence is touched.
//
// Widths are true CSS-pixel 320 and 390 (isMobile + hasTouch, DPR 2/3,
// 320x568 and 390x844 viewports), each with reduced motion and with the
// default motion the incumbent BudgetSheetMotion layer animates. Triggers are
// touched (page.touchscreen, no auto-scroll) after the page has been scrolled
// well down, either fully visible mid-viewport or only partly visible at the
// bottom edge; every page scroll event between tap and settle is recorded.
//
// Limitation: this is headless Chromium device emulation, not physical iOS
// Safari. It cannot reproduce WebKit-only behaviour (dynamic toolbar
// collapse, visual-viewport keyboard shifts, iOS <dialog> quirks). A clean
// negative here does not clear the physical-Safari symptom.
//
// Assertions are recorded (not thrown at first failure) so one run reports
// every row; the process exits 1 if any row FAILS, 0 if all PASS.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');
const root = path.join(__dirname, '..');
const ORIGIN = 'http://budget.test';
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

const VIEWPORTS = [
  { width: 320, height: 568, deviceScaleFactor: 2 },
  { width: 390, height: 844, deviceScaleFactor: 3 },
];
const MOTION = ['reduce', 'no-preference'];
// Household tile rings first (the #741 surface), then the other Household
// operating-surface tiles that open the same native detail sheet from deeper
// in the page.
const TRIGGERS = [
  { key: 'household-ring-groceries', selector: '[data-budget-browse="spending"] [data-blend-cat="groceries"]' },
  { key: 'household-ring-other', selector: '[data-budget-browse="spending"] [data-blend-cat="other-spending"]' },
  { key: 'bills-day', selector: '[data-blend-bill]' },
  { key: 'bills-roster', selector: '[data-blend-bills-open]' },
  { key: 'card-row', selector: '[data-budget-card-toggle]' },
];
const CLOSERS = ['close-button', 'escape'];
// centre: trigger fully visible mid-viewport. bottom-edge: only the trigger's
// top 24px are visible at the bottom of the viewport (a partially scrolled tile).
const POSITIONS = ['centre', 'bottom-edge'];
const TOL = 1; // CSS px rounding tolerance

const rows = [], skips = [], errors = [], external = [], writes = [];
const record = (id, ok, detail) => {
  rows.push({ id, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(detail)}`);
};

async function settle(page) {
  // Two frames for rAF focus restoration, then wait for any WAAPI motion.
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  // Only finite animations (the sheet motion); decorative infinite loops are ignored.
  await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'
    || a.effect?.getComputedTiming().endTime === Infinity), null, { timeout: 5000 });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

const state = (page, selector, index) => page.evaluate(([selector, index]) => {
  const trigger = document.querySelectorAll(selector)[index];
  const dialog = document.querySelector('[data-budget-detail-sheet]');
  const box = node => { if (!node) return null; const r = node.getBoundingClientRect();
    return { top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2), left: +r.left.toFixed(2), right: +r.right.toFixed(2), height: +r.height.toFixed(2) }; };
  const active = document.activeElement;
  return {
    scrollY: Math.round(scrollY * 100) / 100, innerHeight, innerWidth,
    vv: visualViewport ? { pageTop: visualViewport.pageTop, offsetTop: visualViewport.offsetTop, height: visualViewport.height } : null,
    open: !!dialog?.open, dialog: dialog?.open ? box(dialog) : null,
    close: dialog?.open ? box(dialog.querySelector('[data-budget-detail-close]')) : null,
    trigger: box(trigger),
    focusInDialog: !!(dialog && dialog.contains(active)),
    focusIsTrigger: active === trigger,
    focus: active ? active.tagName + (active.getAttribute('data-blend-cat') ? '[cat=' + active.getAttribute('data-blend-cat') + ']'
      : active.getAttribute('data-blend-bill') ? '[bill=' + active.getAttribute('data-blend-bill') + ']'
      : active.getAttribute('data-budget-card-toggle') ? '[card=' + active.getAttribute('data-budget-card-toggle') + ']'
      : active.hasAttribute('data-blend-bills-open') ? '[bills-roster]'
      : active.hasAttribute('data-budget-detail-close') ? '[close]' : '') : null,
    bodyLocked: document.body.classList.contains('budget-detail-open'),
    dockTop: (() => { const dock = document.querySelector('.sitenav-household');
      return dock && getComputedStyle(dock).position === 'fixed' && dock.getClientRects().length
        ? +dock.getBoundingClientRect().top.toFixed(2) : null; })(),
  };
}, [selector, index]);

const inViewport = (b, s) => !!b && b.top >= -TOL && b.left >= -TOL
  && b.bottom <= s.innerHeight + TOL && b.right <= s.innerWidth + TOL;

async function scenario(browser, vp, motion, trigger, closer, position) {
  const tag = `${vp.width}|${motion}|${trigger.key}|${position}|${closer}`;
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor, isMobile: true, hasTouch: true,
    reducedMotion: motion, colorScheme: 'light' });
  try {
    await context.route('**/*', route => {
      const request = route.request(), u = new URL(request.url());
      if (request.method() !== 'GET') { writes.push(request.method() + ' ' + u.pathname); return route.abort(); }
      if (u.origin !== ORIGIN) { external.push(u.origin); return route.abort(); }
      if (u.pathname === '/data.json') return route.fulfill({ json: fx.served() });
      if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
      const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
      if (!file.startsWith(path.join(root, 'public')) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.css') ? 'text/css'
        : file.endsWith('.js') ? 'application/javascript' : file.endsWith('.woff2') ? 'font/woff2' : 'text/html' });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', e => errors.push(tag + ': ' + e.message));
    await page.goto(ORIGIN + '/?view=classic');
    await page.locator('[data-budget-surface]').waitFor();
    assert.equal(await page.evaluate(() => App.data.meta.title), 'Synthetic Budget surface');
    assert.equal(await page.evaluate(() => document.documentElement.clientWidth), vp.width, 'true CSS-pixel width');

    // Pick the first rendered (visible) instance of the trigger.
    const index = await page.evaluate(s => [...document.querySelectorAll(s)]
      .findIndex(n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden'), trigger.selector);
    assert.ok(index >= 0, tag + ': visible trigger exists');
    // The page is scrolled well down before every tap.
    const wanted = await page.evaluate(([s, i, position]) => {
      const n = document.querySelectorAll(s)[i], r = n.getBoundingClientRect();
      const target = scrollY + (position === 'centre' ? r.top + r.height / 2 - innerHeight / 2 : r.top - (innerHeight - 24));
      window.scrollTo(0, Math.max(0, target));
      return target;
    }, [trigger.selector, index, position]);
    if (wanted < 0) {
      // Geometry, not product: the trigger sits in the first screen of the
      // document, so it cannot be placed at this position. Not a PASS or FAIL.
      skips.push({ id: `${tag} SKIP position-unreachable`, wantedScrollY: Math.round(wanted) });
      console.log(`SKIP ${tag} position-unreachable ${JSON.stringify({ wantedScrollY: Math.round(wanted) })}`);
      return;
    }
    await settle(page);
    const before = await state(page, trigger.selector, index);
    const visibleTop = Math.max(0, before.trigger.top), visibleBottom = Math.min(before.innerHeight, before.trigger.bottom);
    record(`${tag} PRE trigger-at-position`, visibleBottom - visibleTop >= 12 && (position === 'bottom-edge'
      ? before.trigger.bottom > before.innerHeight + TOL : before.scrollY > 200 && inViewport(before.trigger, before)),
    { scrollY: before.scrollY, trigger: before.trigger });
    // Real touch at the centre of the trigger's *visible* part; no Playwright
    // auto-scroll, so "before" really is the pre-tap scroll position.
    const x = Math.round((before.trigger.left + before.trigger.right) / 2), y = Math.round((visibleTop + visibleBottom) / 2);
    assert.equal(await page.evaluate(([s, i, x, y]) => document.querySelectorAll(s)[i].contains(document.elementFromPoint(x, y)),
      [trigger.selector, index, x, y]), true, tag + ': tap point hits the trigger');
    // Record every page scroll between tap and settle (transient jumps too).
    const track = () => page.evaluate(() => { window.__hpvScroll = [scrollY];
      if (!window.__hpvListen) { window.__hpvListen = true; addEventListener('scroll', () => window.__hpvScroll.push(scrollY), { passive: true }); } });
    const tracked = () => page.evaluate(() => window.__hpvScroll.map(v => Math.round(v * 100) / 100));
    await track();
    await page.touchscreen.tap(x, y);
    await page.locator('[data-budget-detail-sheet][open]').waitFor();
    await settle(page);
    const opened = await state(page, trigger.selector, index);
    const openTrail = await tracked();
    record(`${tag} OPEN no-transient-page-scroll`, openTrail.every(v => Math.abs(v - before.scrollY) <= TOL),
      { min: Math.min(...openTrail), max: Math.max(...openTrail), events: openTrail.length - 1 });
    record(`${tag} OPEN dialog-open`, opened.open && opened.bodyLocked, { open: opened.open, bodyLocked: opened.bodyLocked });
    record(`${tag} OPEN panel-inside-current-viewport`, inViewport(opened.dialog, opened),
      { dialog: opened.dialog, viewport: [opened.innerWidth, opened.innerHeight] });
    record(`${tag} OPEN close-control-inside-viewport`, inViewport(opened.close, opened), { close: opened.close });
    record(`${tag} OPEN no-page-scroll (upward-scroll symptom)`, Math.abs(opened.scrollY - before.scrollY) <= TOL,
      { before: before.scrollY, after: opened.scrollY, delta: +(opened.scrollY - before.scrollY).toFixed(2) });
    record(`${tag} OPEN visual-viewport-unshifted`, !opened.vv || Math.abs(opened.vv.offsetTop) <= TOL,
      { vv: opened.vv });
    record(`${tag} OPEN focus-inside-panel`, opened.focusInDialog, { focus: opened.focus });

    await track();
    if (closer === 'escape') await page.keyboard.press('Escape');
    else await page.touchscreen.tap(Math.round((opened.close.left + opened.close.right) / 2), Math.round((opened.close.top + opened.close.bottom) / 2));
    await page.locator('[data-budget-detail-sheet]').waitFor({ state: 'hidden' });
    await settle(page);
    const closed = await state(page, trigger.selector, index);
    const closeTrail = await tracked();
    record(`${tag} CLOSE dialog-closed-unlocked`, !closed.open && !closed.bodyLocked, { open: closed.open, bodyLocked: closed.bodyLocked });
    record(`${tag} CLOSE no-upward-scroll (upward-scroll symptom)`, closeTrail.every(v => v >= before.scrollY - TOL),
      { before: before.scrollY, min: Math.min(...closeTrail), after: closed.scrollY, events: closeTrail.length - 1 });
    // A fully visible trigger must come back exactly. A partially hidden one is
    // deliberately revealed by the incumbent focus restoration (plan.js
    // focus() 'nearest' with scroll-margin-block, budget-blend.js close
    // handler 'center' when the return target is clipped), so for it only the
    // direction is asserted: downward reveal, never upward; delta is recorded.
    if (position === 'centre') record(`${tag} CLOSE scroll-restored`, Math.abs(closed.scrollY - before.scrollY) <= TOL,
      { before: before.scrollY, after: closed.scrollY, delta: +(closed.scrollY - before.scrollY).toFixed(2) });
    else record(`${tag} CLOSE reveal-is-downward`, closed.scrollY >= before.scrollY - TOL,
      { before: before.scrollY, after: closed.scrollY, delta: +(closed.scrollY - before.scrollY).toFixed(2),
        hiddenBelow: +(before.trigger.bottom - before.innerHeight).toFixed(2) });
    record(`${tag} CLOSE focus-returns-to-trigger`, closed.focusIsTrigger, { focus: closed.focus });
    record(`${tag} CLOSE trigger-inside-viewport-above-dock`, inViewport(closed.trigger, closed)
      && (closed.dockTop == null || closed.trigger.bottom <= closed.dockTop + TOL), { trigger: closed.trigger, dockTop: closed.dockTop });
  } catch (error) {
    record(`${tag} HARNESS`, false, { error: error.message.split('\n')[0] });
  } finally {
    await context.close();
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  try {
    for (const vp of VIEWPORTS) for (const motion of MOTION) for (const trigger of TRIGGERS)
      for (const position of POSITIONS) for (const closer of CLOSERS) await scenario(browser, vp, motion, trigger, closer, position);
  } finally {
    await browser.close();
  }
  record('GLOBAL zero-external-requests', external.length === 0, { external });
  record('GLOBAL zero-writes', writes.length === 0, { writes });
  record('GLOBAL zero-page-errors', errors.length === 0, { errors });
  const failed = rows.filter(row => !row.ok);
  const out = process.env.ATLAS_HOUSEHOLD_VIEWPORT_PROOF;
  if (out) fs.writeFileSync(out, JSON.stringify({ head, browser: browser.version(), rows, skips }, null, 2));
  console.log(`head ${head} browser ${browser.version()} rows ${rows.length} pass ${rows.length - failed.length} fail ${failed.length} skipped-scenarios ${skips.length}`);
  if (failed.length) {
    console.log('FAILED ROWS:\n' + failed.map(row => '  ' + row.id + ' ' + JSON.stringify(row.detail)).join('\n'));
    process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
