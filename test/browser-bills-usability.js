'use strict';
// Full native Budget/App/Forecast path, invented bills only. Optional browser
// proof: NODE_PATH=<playwright> CHROME_PATH=<Chromium> node test/browser-bills-usability.js
// After committing, BILLS_SOURCE_BOUND=1 requires exact Git bytes and a clean
// checkout. Screenshots stay outside Git unless deliberately added as proof.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');
const root = path.join(__dirname, '..');
const output = process.env.BILLS_PROOF_DIR || path.join(require('node:os').tmpdir(), 'atlas-bills-usability');
fs.mkdirSync(output, { recursive: true });
const sourceBound = process.env.BILLS_SOURCE_BOUND === '1';
const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceBinding = { head: git(['rev-parse', 'HEAD']).toString().trim(),
  tree: git(['rev-parse', 'HEAD^{tree}']).toString().trim(), files: {}, dependencies: {} };
if (sourceBound) assert.equal(git(['status', '--porcelain']).toString().trim(), '', 'Source-bound proof starts clean');
function bindFile(file, bytes = fs.readFileSync(file)) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  const bound = { sha256: sha(bytes), bytes: bytes.length };
  if (sourceBound) {
    bound.blob = git(['rev-parse', 'HEAD:' + relative]).toString().trim();
    assert.equal(sha(git(['cat-file', 'blob', bound.blob])), bound.sha256, relative + ' is exact Git bytes');
  }
  return bound;
}
function fixture() {
  const data = fx.served();
  for (let i = 0; i < 3; i++) data.plan.bills.push({ id: `synthetic-extra-${i}`, label: `Synthetic service ${i + 1}`,
    frequency: 'monthly', day: 24, amount: 20 + i, confidence: i === 1 ? 'estimated' : 'confirmed', payingAccount: 'chequing-a' });
  for (let i = 0; i < 7; i++) data.plan.bills.push({ id: `synthetic-roster-${i}`, label: `Synthetic household bill ${i + 1}`,
    frequency: 'monthly', day: 26, amount: 10 + i, confidence: 'confirmed', payingAccount: 'chequing-a' });
  return data;
}
(async () => {
  // Bind the actual CommonJS fixture/preprocessing dependency closure, including
  // dependencies loaded lazily by served(), rather than only browser assets.
  fixture();
  const dependencies = Object.keys(require.cache).filter(file => {
    const relative = path.relative(root, file);
    return !relative.startsWith('..') && !path.isAbsolute(relative) && !relative.startsWith('node_modules' + path.sep);
  }).concat([path.join(root, 'package.json'), path.join(root, 'package-lock.json')]);
  for (const file of [...new Set(dependencies)].sort())
    sourceBinding.dependencies[path.relative(root, file).split(path.sep).join('/')] = bindFile(file);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const runtime = { node: process.version, platform: process.platform,
    playwright: require('playwright/package.json').version, chromium: browser.version() };
  const errors = [], writes = [], measurements = [], shots = [], screenshotHashes = {}, inputs = [], focusedFlows = [];
  try {
    for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme,
        reducedMotion: 'reduce', hasTouch: width < 400, isMobile: width < 400 });
      await context.addInitScript(chosen => localStorage.setItem('hfd-theme', chosen), theme);
      const data = fixture();
      inputs.push({ width, theme, sha256: sha(Buffer.from(JSON.stringify(data))) });
      await context.route('**/*', route => {
        if (route.request().method() !== 'GET') writes.push(route.request().method());
        const url = new URL(route.request().url());
        if (url.origin !== 'http://bills.test') return route.abort();
        if (url.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return route.fulfill({ json: null });
        const file = path.join(root, 'public', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        const bytes = fs.readFileSync(file), relative = path.relative(root, file).split(path.sep).join('/');
        const bound = bindFile(file, bytes);
        assert.ok(!sourceBinding.files[relative] || sourceBinding.files[relative].sha256 === bound.sha256);
        sourceBinding.files[relative] = bound;
        return route.fulfill({ body: bytes, contentType: file.endsWith('.js') ? 'application/javascript'
          : file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'text/html' });
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(`${width}/${theme}: ${error.message}`));
      const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const waitMotion = () => page.waitForFunction(() => {
        const dialog = document.querySelector('[data-budget-detail-sheet]');
        return !document.querySelector('.budget-sheet-motion-shell') && !dialog?.getAnimations({ subtree: true })
          .some(a => !('animationName' in a) && !('transitionProperty' in a) && a.playState === 'running');
      }, undefined, { timeout: 3000 });
      const sheet = () => page.locator('[data-budget-detail-sheet][open]');
      const close = async (opener, expanded = true) => {
        await page.locator('[data-budget-detail-close]').click(); await settle();
        assert.equal(await sheet().count(), 0);
        assert.equal(await opener.evaluate(el => document.activeElement === el), true, 'Close restores the visible opener');
        if (expanded) assert.equal(await opener.getAttribute('aria-expanded'), 'false');
      };
      const row = (id, date) => page.locator(`[data-blend-bill="${id}:${date}"]`);
      const visibleRows = () => sheet().locator('.budget-bill-row:visible');
      const takeShot = async name => {
        await settle(); const file = `${width}-${theme}-${name}.png`;
        await page.screenshot({ path: path.join(output, file) }); shots.push(file);
        const bytes = fs.readFileSync(path.join(output, file));
        screenshotHashes[file] = { sha256: sha(bytes), bytes: bytes.length };
      };
      await page.goto('http://bills.test'); await page.locator('[data-blend-bill-list]').waitFor(); await settle();
      const originalData = await page.evaluate(() => JSON.stringify(App.data));
      const period = () => page.locator('[data-budget-window-progress]').getAttribute('data-start');
      const originalPeriod = await period();
      // #824: the face is a list, one row per bill. Each row opens that one
      // bill's native detail directly; there is no calendar day list any more.
      assert.equal(await page.locator('[data-blend-bill-list] [data-blend-bill]').count(), 14, 'one face row per bill');
      assert.equal(await page.locator('[data-blend-cal], .blend-day').count(), 0, 'no calendar grid');
      const frames = () => page.evaluate(() => document.querySelector('[data-budget-detail-sheet]').budgetSheet.snapshot().frames.length);
      const four = row('internet', '2026-08-24');
      assert.ok((await four.boundingBox()).height >= 44, 'whole-row hit target');
      await page.keyboard.press('Tab'); await four.focus(); await four.scrollIntoViewIfNeeded();
      const keyboardFocus = await four.evaluate(el => {
        const style = getComputedStyle(el);
        return { visible: el.matches(':focus-visible'), outlineWidth: parseFloat(style.outlineWidth), outlineStyle: style.outlineStyle };
      });
      assert.equal(keyboardFocus.visible, true); assert.equal(keyboardFocus.outlineStyle, 'solid');
      assert.ok(keyboardFocus.outlineWidth >= 2);
      await takeShot('list-keyboard-focus');
      focusedFlows.push({ width, theme, flow: 'keyboard focus outlines the whole bill row', ...keyboardFocus });
      // Every part of the row opens the same single bill detail, once.
      for (const part of ['[data-blend-bill-when]', '[data-blend-bill-name]', '[data-blend-bill-amount]', '[data-blend-bill-status]']) {
        await four.scrollIntoViewIfNeeded();
        const box = await four.locator(part).boundingBox();
        if (width < 400) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        else await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        assert.equal(await page.locator('dialog[open]').count(), 1, 'one native modal owns the detail');
        await four.evaluate(el => { el.click(); el.click(); });
        assert.equal(await frames(), 1);
        const detail = sheet().locator('[data-bill-detail]');
        assert.equal(await detail.count(), 1);
        assert.equal(await detail.locator('summary').first().getAttribute('data-period-bill'), 'internet');
        assert.equal(await detail.locator('summary').first().getAttribute('data-bill-date'), '2026-08-24');
        assert.match(await detail.innerText(), /Transaction evidence is unavailable.*Missing evidence does not mean unpaid/s);
        assert.equal(await page.locator('[data-budget-detail-back]').isVisible(), false);
        assert.equal(await period(), originalPeriod);
        await close(four);
      }
      await four.focus(); await page.keyboard.press('Enter');
      assert.equal(await sheet().locator('[data-period-bill="internet"]').count(), 1);
      await takeShot('one-bill-row-detail'); await close(four);
      // Bills sharing a date each keep their own row and open their own detail.
      for (const id of ['internet', 'synthetic-extra-0', 'synthetic-extra-1', 'synthetic-extra-2']) {
        const opener = row(id, '2026-08-24');
        const printed = await opener.locator('[data-blend-bill-name]').innerText();
        await opener.focus(); await page.keyboard.press(id === 'internet' ? 'Space' : 'Enter');
        const detail = sheet().locator('[data-bill-detail]');
        assert.equal(await detail.count(), 1);
        assert.equal(await detail.locator('summary').first().getAttribute('data-period-bill'), id);
        assert.equal(await detail.locator('summary').first().getAttribute('data-bill-date'), '2026-08-24');
        assert.match(await page.locator('[data-budget-detail-title]').innerText(), new RegExp(printed));
        assert.equal(await frames(), 1);
        await opener.evaluate(el => { el.click(); el.click(); });
        assert.equal(await frames(), 1); assert.equal(await page.locator('dialog[open]').count(), 1);
        await close(opener);
      }
      // Same-period remount retains the detail identity and the final opener.
      await four.click(); await page.evaluate(() => App.rerender()); await settle();
      assert.equal(await sheet().locator('[data-period-bill]').getAttribute('data-period-bill'), 'internet');
      await close(four);
      await four.focus(); await page.keyboard.press('Space'); assert.equal(await sheet().locator('[data-period-bill="internet"]').count(), 1);
      await page.keyboard.press('Escape'); await settle(); assert.equal(await four.evaluate(el => document.activeElement === el), true);
      // One-bill paid and uncertain days open the exact incumbent evidence.
      for (const [id, date, status] of [['mortgage', '2026-08-15', 'PAID'], ['hydro', '2026-08-18', 'to confirm']]) {
        const single = page.locator(`[data-blend-bill="${id}:${date}"]`);
        await single.click({ position: { x: 8, y: 28 } });
        const summary = sheet().locator(`[data-period-bill="${id}"]`);
        assert.equal(await summary.getAttribute('data-bill-date'), date);
        assert.equal(await summary.getAttribute('data-bill-status'), status);
        assert.equal(await page.locator('[data-budget-detail-back]').isVisible(), false);
        await close(single);
      }
      // The hero opens the same compact roster; details remain one tap away.
      const hero = page.locator('[data-operating-question="04"] .budget-step-summary');
      const heading = page.locator('[data-blend-bills-open]');
      const headingEscape = async motion => {
        await heading.focus(); await page.keyboard.press('Enter'); await waitMotion();
        assert.equal(await visibleRows().count(), 14);
        await page.keyboard.press('Escape'); await settle(); await waitMotion();
        assert.equal(await heading.evaluate(el => document.activeElement === el), true, 'Escape restores exact Bills heading origin');
        assert.equal(await heading.getAttribute('aria-expanded'), 'false');
        assert.equal(await period(), originalPeriod);
        focusedFlows.push({ width, theme, motion, flow: 'Bills heading Enter/Escape', focus: 'Bills heading' });
      };
      await headingEscape('reduce');
      await hero.focus(); await page.keyboard.press('Enter'); assert.equal(await visibleRows().count(), 14);
      await hero.evaluate(el => { el.click(); el.click(); });
      assert.equal(await page.evaluate(() => document.querySelector('[data-budget-detail-sheet]').budgetSheet.snapshot().frames.length), 1);
      assert.equal(await sheet().locator('[data-budget-bill-day]').count(), 0);
      assert.equal(await sheet().locator('[data-bill-detail]').count(), 0, 'no repeated large detail summaries in the roster');
      const metrics = await visibleRows().evaluateAll(rows => ({ count: rows.length,
        visibleWithinViewport: rows.filter(r => { const b = r.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; }).length,
        heights: rows.map(r => r.getBoundingClientRect().height),
        amountSizes: rows.map(r => parseFloat(getComputedStyle(r.querySelector('.budget-bill-amount')).fontSize)),
        nameSizes: rows.map(r => parseFloat(getComputedStyle(r.querySelector('strong')).fontSize)),
        amounts: rows.map(r => {
          const el = r.querySelector('.budget-bill-amount'), range = document.createRange();
          range.selectNodeContents(el);
          const rects = [...range.getClientRects()].filter(b => b.width > 2 && b.height > 2);
          const bounds = el.getBoundingClientRect(), row = r.getBoundingClientRect();
          return { id: r.dataset.budgetBillOpen, text: el.textContent.trim(),
            lines: new Set(rects.map(b => Math.round(b.top))).size,
            rightWithinRow: bounds.right <= row.right, scrollOverflow: el.scrollWidth > el.clientWidth };
        }),
        pageOverflow: document.documentElement.scrollWidth > innerWidth }));
      assert.ok(metrics.heights.every(h => h >= 44));
      assert.ok(metrics.nameSizes.every(size => size >= 15)); assert.ok(metrics.amountSizes.every(size => size <= 16));
      assert.equal(metrics.pageOverflow, false);
      assert.ok(metrics.amounts.every(a => a.lines === 1 && a.rightWithinRow && !a.scrollOverflow), 'compact fixture amounts fit on one line');
      if (width === 1440) assert.ok(metrics.visibleWithinViewport >= 10, JSON.stringify(metrics));
      measurements.push({ width, theme, ...metrics }); await takeShot('compact-hero-bills');
      await sheet().locator('[data-budget-bill-open="internet"]').click();
      assert.equal(await sheet().locator('[data-period-bill]').getAttribute('data-period-bill'), 'internet');
      await page.locator('[data-budget-detail-back]').click(); assert.equal(await visibleRows().count(), 14);
      const last = visibleRows().last(); await last.scrollIntoViewIfNeeded();
      const lastId = await last.getAttribute('data-budget-bill-open'); await last.click();
      assert.equal(await sheet().locator('[data-period-bill]').getAttribute('data-period-bill'), lastId, 'scrolling reaches the last bill');
      await page.locator('[data-budget-detail-back]').click();
      assert.equal(await last.evaluate(el => document.activeElement === el), true);
      // Preserve the native filters and the original period evidence controls.
      const controls = sheet().locator('.blend-bill-list-context'); await controls.locator(':scope > summary').click();
      await sheet().locator('[data-budget-bill-filter="paid"]').click();
      assert.equal(await visibleRows().count(), 1); assert.equal(await visibleRows().first().getAttribute('data-budget-bill-open'), 'mortgage');
      await sheet().locator('[data-budget-bill-filter="all"]').click(); assert.equal(await visibleRows().count(), 14);
      await controls.locator(':scope > summary').click();
      await page.evaluate(() => App.rerender()); await settle(); assert.equal(await visibleRows().count(), 14);
      await close(hero);
      // Native period navigation remounts the roster without stale date filters.
      const river = page.locator('.g-river-wrap .river'); await river.focus(); await page.keyboard.press('ArrowRight'); await settle();
      assert.notEqual(await period(), originalPeriod);
      await hero.click(); assert.equal(await sheet().locator('[data-budget-bill-day]').count(), 0);
      await close(hero); await river.focus(); await page.keyboard.press('ArrowLeft'); await settle();
      assert.equal(await period(), originalPeriod);
      await four.click(); assert.equal(await sheet().locator('[data-period-bill="internet"]').count(), 1); await close(four);

      const periodWhy = async motion => {
        await hero.click(); await waitMotion();
        await sheet().locator('[data-budget-bill-filter="paid"]').click();
        const controls = sheet().locator('.blend-bill-list-context');
        if (!await controls.evaluate(el => el.open)) await controls.locator(':scope > summary').click();
        const why = controls.locator('[data-budget-browse-evidence="04"]');
        const original = await page.locator('[data-operating-question="04"] .budget-step-body').elementHandle();
        await why.focus(); await why.click(); await waitMotion();
        assert.equal(await page.locator('dialog[open]').count(), 1);
        assert.equal(await page.locator('[data-budget-detail-title]').innerText(), 'Bills deduction evidence');
        assert.equal(await sheet().locator('[data-budget-detail-body] > .budget-step-body').evaluate((el, node) => el === node, original), true,
          'Why moves the original deduction evidence into the existing sheet');
        assert.equal(await page.evaluate(() => document.querySelector('[data-budget-detail-sheet]').budgetSheet.snapshot().frames.length), 2);
        await page.locator('[data-budget-detail-back]').click(); await waitMotion();
        assert.equal(await why.evaluate(el => document.activeElement === el), true, 'Back restores the Why button');
        assert.equal(await controls.evaluate(el => el.open), true, 'Period figures remains expanded after Back');
        assert.equal(await sheet().locator('[data-budget-bill-filter="paid"]').getAttribute('aria-pressed'), 'true');
        assert.equal(await visibleRows().count(), 1);
        assert.equal(await visibleRows().first().getAttribute('data-budget-bill-open'), 'mortgage');
        assert.equal(await page.locator('[data-operating-question="04"] .budget-step-body').evaluate((el, node) => el === node, original), true);
        if (motion === 'reduce') await takeShot('period-figures-back');
        await why.click(); await waitMotion(); await close(hero); await waitMotion();
        assert.equal(await page.locator('[data-operating-question="04"] .budget-step-body').evaluate((el, node) => el === node, original), true,
          'Close releases the original evidence and restores the hero opener');
        assert.equal(await period(), originalPeriod);
        focusedFlows.push({ width, theme, motion, flow: 'Period figures → Why → Back → Why → Close',
          originalSource: true, filterRetained: 'paid', backFocus: 'Why', closeFocus: 'hero' });
        await original.dispose();
      };
      await periodWhy('reduce');

      // Use normal WAAPI motion. DOM click bursts deliberately bypass
      // Playwright's animation/stability waits to exercise actions in flight.
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), false);
      await headingEscape('no-preference');
      // A queued native close event must not let the previous bill row
      // steal focus from the new heading or hero opener after reversal.
      for (const [name, opener] of [['heading', heading], ['hero', hero]]) {
        await four.evaluate((el, selector) => {
          el.click(); document.querySelector('[data-budget-detail-close]').click();
          document.querySelector(selector).click();
        }, name === 'heading' ? '[data-blend-bills-open]' : '[data-operating-question="04"] .budget-step-summary');
        assert.equal(await visibleRows().count(), 14); await waitMotion();
        await page.keyboard.press('Escape'); await settle(); await waitMotion();
        assert.equal(await opener.evaluate(el => document.activeElement === el), true, 'rapid row Close/new opener Escape restores exact new origin');
        assert.equal(await four.getAttribute('aria-expanded'), 'false');
        focusedFlows.push({ width, theme, motion: 'no-preference', flow: 'row Close/' + name + ' open/Escape', focus: name });
      }
      for (const [name, opener, expected] of [['row', four, 0], ['hero', hero, 14]]) {
        await opener.scrollIntoViewIfNeeded();
        const burst = await opener.evaluate(el => {
          el.focus(); el.click(); el.click(); el.click();
          const dialog = document.querySelector('[data-budget-detail-sheet]');
          const before = { open: dialog.open, frames: dialog.budgetSheet.snapshot().frames.length,
            active: dialog.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length };
          const close = dialog.querySelector('[data-budget-detail-close]'); close.click(); close.click();
          return { ...before, closed: !dialog.open, focus: document.activeElement === el,
            expandedAtNativeClose: el.getAttribute('aria-expanded'), shells: document.querySelectorAll('.budget-sheet-motion-shell').length };
        });
        assert.ok(burst.open && burst.active > 0, 'normal entry motion was active during the burst');
        assert.equal(burst.frames, 1); assert.ok(burst.closed && burst.focus);
        assert.equal(burst.shells, 0, 'second Close cancels decorative departure');
        // Native dialog close dispatch is asynchronous; the skin clears its
        // projected opener state when that event arrives.
        await settle(); await waitMotion();
        const expandedAfterCloseEvent = await opener.getAttribute('aria-expanded');
        assert.equal(expandedAfterCloseEvent, 'false');

        const reversal = await opener.evaluate(el => {
          el.click(); document.querySelector('[data-budget-detail-close]').click(); el.click(); el.click();
          const dialog = document.querySelector('[data-budget-detail-sheet]');
          return { frames: dialog.budgetSheet.snapshot().frames.length,
            shells: document.querySelectorAll('.budget-sheet-motion-shell').length };
        });
        assert.equal(reversal.frames, 1); assert.equal(reversal.shells, 0, 'reopening cancels the old departure shell');
        assert.equal(await visibleRows().count(), expected);
        await page.keyboard.press('Escape'); await waitMotion();
        assert.equal(await sheet().count(), 0); assert.equal(await opener.evaluate(el => document.activeElement === el), true);
        assert.equal(await page.evaluate(() => document.querySelector('[data-budget-detail-sheet]').budgetSheet.snapshot()), null);
        focusedFlows.push({ width, theme, motion: 'no-preference', flow: name + ' rapid open/Close/reopen/Escape', ...burst, expandedAfterCloseEvent });
      }

      const drill = await heading.evaluate(el => {
        el.click(); el.click();
        const dialog = document.querySelector('[data-budget-detail-sheet]');
        const row = dialog.querySelector('[data-budget-bill-open="internet"]'); row.click(); row.click(); row.click();
        const frames = dialog.budgetSheet.snapshot().frames.length;
        const active = dialog.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length;
        dialog.querySelector('[data-budget-detail-back]').click(); dialog.querySelector('[data-budget-detail-back]').click();
        return { frames, active, backFrames: dialog.budgetSheet.snapshot().frames.length, focus: document.activeElement === row };
      });
      assert.equal(drill.frames, 2); assert.ok(drill.active > 0); assert.equal(drill.backFrames, 1); assert.ok(drill.focus);
      assert.equal(await visibleRows().count(), 14); await close(heading); await waitMotion();
      focusedFlows.push({ width, theme, motion: 'no-preference', flow: 'rapid detail/Back', ...drill });

      const resize = await heading.evaluate(el => {
        el.click(); const dialog = document.querySelector('[data-budget-detail-sheet]');
        const before = dialog.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length;
        window.dispatchEvent(new Event('resize'));
        return { before, after: dialog.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length, open: dialog.open };
      });
      assert.ok(resize.before > 0); assert.equal(resize.after, 0); assert.ok(resize.open);
      assert.equal(await visibleRows().count(), 14); await close(heading); await waitMotion();
      focusedFlows.push({ width, theme, motion: 'no-preference', flow: 'resize cancels decoration, retains native list', ...resize });

      await heading.evaluate(el => el.click());
      const detached = await sheet().elementHandle();
      assert.ok(await detached.evaluate(el => el.getAnimations({ subtree: true }).some(a => a.playState === 'running')));
      await page.evaluate(() => App.rerender()); await settle(); await sheet().waitFor(); await waitMotion();
      assert.equal(await detached.evaluate(el => el.isConnected), false);
      assert.equal(await detached.evaluate(el => el.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length), 0);
      assert.equal(await visibleRows().count(), 14); await close(heading); await waitMotion(); await detached.dispose();
      focusedFlows.push({ width, theme, motion: 'no-preference', flow: 'remount cancels detached animation, restores native roster' });
      await periodWhy('no-preference');
      await hero.click(); await waitMotion(); await takeShot('normal-motion-compact-hero-bills'); await close(hero); await waitMotion();

      // Compare the compact Bills treatment to the existing native Income
      // popup using the same invented fixture and current source/theme.
      const income = page.locator('[data-operating-question="02"] .budget-step-summary');
      await income.click(); await waitMotion(); await takeShot('native-income-reference'); await close(income, false); await waitMotion();
      assert.equal(await page.evaluate(() => JSON.stringify(App.data)), originalData, 'interaction never mutates source or settlement');
      await context.close();
    }
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    if (sourceBound) {
      assert.equal(git(['rev-parse', 'HEAD']).toString().trim(), sourceBinding.head);
      for (const [file, bound] of Object.entries({ ...sourceBinding.files, ...sourceBinding.dependencies }))
        assert.equal(sha(fs.readFileSync(path.join(root, file))), bound.sha256);
      assert.equal(git(['status', '--porcelain']).toString().trim(), '', 'Source-bound proof ends clean');
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ sourceBound, sourceBinding, runtime, inputs,
      measurements, focusedFlows, shots, screenshotHashes, errors, writes }, null, 2));
    console.log('PASS Bills list rows/compact roster and normal-motion bursts/cancellation; Period figures/Why Back/Close focus; 1440/390/320 light/dark');
    console.log(JSON.stringify({ sourceBound, head: sourceBinding.head, output, desktop: measurements.filter(m => m.width === 1440) }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
