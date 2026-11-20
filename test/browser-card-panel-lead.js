'use strict';
// Browser proof for the Atlas-approved card-detail panel cleanup, driven
// through actual App.boot renders and visible controls only:
//  (a) a genuine-zero reported balance renders visibly as $0.00 in the
//      panel lead;
//  (b) a missing/unavailable reported balance is never fabricated — the
//      lead shows the unavailable state, never an invented zero (the
//      future period, where Forecast publishes no current stock, is the
//      missing-balance state, reached by the app's own window-step
//      control);
//  (c) keyboard AND touch operation at 320px, 390px and desktop widths
//      in both themes — open the sheet, expand/collapse the native
//      "Balance and payment details" disclosure, close the sheet;
//  (d) close/reopen behaviour — focus returns to the card trigger on
//      close, and the disclosure is collapsed again on reopen even
//      though the sheet re-homes the same panel node;
//  (e) Travel-panel ordering under the blend skin — the strip's
//      re-homed posted-status paragraph follows the balance lead,
//      never precedes it, in the current "Posted through …" state and
//      the future "Posted activity not observed" state, across
//      rerenders (window steps) and close/reopen, present exactly
//      once (advisory P2 4252570044);
//  (f) Travel-panel ordering across a rerender while the sheet is
//      open (advisory P2 4252814318) — the remount restores the
//      Travel panel into the new dialog before the blend paint runs;
//      the status must still be placed in the Travel panel, after
//      its lead, and in no other panel.
// Invented data; all network intercepted. No credentials, live accounts,
// writes or DOM financial stubs.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { chromium } = require('playwright');
const fx = require('./fixtures/card-period-movements-data');
const root = path.join(__dirname, '..');
const out = process.env.ATLAS_BUDGET_SCREENSHOTS_DIR || path.join(require('node:os').tmpdir(), 'card-panel-lead');
fs.mkdirSync(out, { recursive: true });
// Source binding: a git blob SHA is a content address — sha1 of
// "blob <bytes>\0" + bytes — so every exercised source below resolves by
// content in the pushed head on GitHub, independent of commit identity.
const blobSha = file => {
  const bytes = fs.readFileSync(file);
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};
const exercisedSources = [
  'public/index.html', 'public/app.js', 'public/plan.js', 'public/forecast.js',
  'public/budget-surface.js', 'public/budget-card-movements.js', 'public/budget-blend.js',
  'public/budget-river.js', 'public/budget-blend.css', 'public/budget-surface.css',
  'public/budget-gface.css', 'public/budget-sheet-motion.css',
  'test/browser-card-panel-lead.js',
  'test/fixtures/card-period-movements-data.js', 'test/fixtures/budget-surface-data.js',
];
const sourceBlobs = {};
for (const rel of exercisedSources) sourceBlobs[rel] = blobSha(path.join(root, rel));
const sha256File = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const screenshots = [];
const states = [], errors = [], writes = [], external = [];
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const runtime = { node: process.version, chromium: await browser.version(), platform: process.platform };
  const boot = async (data, width, theme = 'light', touch = false) => {
    const context = await browser.newContext({ viewport: { width, height: 1000 },
      reducedMotion: 'reduce', colorScheme: theme, hasTouch: touch, isMobile: touch });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.origin !== 'http://panel.test') { external.push(u.origin); return route.abort(); }
      if (route.request().method() !== 'GET') writes.push(route.request().method());
      if (u.pathname === '/data.json') return route.fulfill({ json: data });
      if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
      const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
      return fs.existsSync(file) ? route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }) : route.fulfill({ status: 404, body: '' });
    });
    await page.goto('http://panel.test/?view=classic');
    if (theme === 'dark') await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    return page;
  };
  const capture = async (locator, name, meta) => {
    const file = path.join(out, name);
    await locator.page().evaluate(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
    await locator.screenshot({ path: file, animations: 'disabled' });
    screenshots.push({ file: name, ...meta });
  };
  const leadText = panel => panel.locator('.card-movement-lead').innerText();
  const detailsOpen = panel => panel.locator('details.card-movement-details').evaluate(el => el.open);
  // Travel ordering (advisory P2 4252570044): the blend skin's
  // paintCards() re-homes the strip's posted-status paragraph into
  // panels[0] — the Travel panel. The reported-balance lead must stay
  // the panel's first content, the status must sit immediately after
  // it, and the status must appear exactly once.
  const travelOrder = panel => panel.evaluate(el => {
    const lead = el.querySelector('.card-movement-lead');
    const notes = [...el.querySelectorAll('.blend-card-posted')];
    return {
      firstIsLead: !!lead && el.firstElementChild === lead,
      noteCount: notes.length,
      noteText: notes.length === 1 ? notes[0].textContent.trim() : null,
      noteAfterLead: !!lead && notes.length === 1 && lead.nextElementSibling === notes[0],
    };
  });
  const assertTravelOrder = async (panel, notePattern, where) => {
    const order = await travelOrder(panel);
    assert.equal(order.firstIsLead, true,
      `${where}: Travel panel leads with the reported balance, ahead of the re-homed status`);
    assert.equal(order.noteCount, 1,
      `${where}: Travel panel carries the posted status exactly once`);
    assert.match(order.noteText || '', notePattern,
      `${where}: Travel posted status text is preserved`);
    assert.equal(order.noteAfterLead, true,
      `${where}: Travel posted status sits immediately after the balance lead`);
  };
  try {
    // (a)+(b) lead truth at 390px in both themes, plus canonical captures.
    for (const theme of ['light', 'dark']) {
      const zeroData = fx.served();
      zeroData.debts.find(debt => debt.id === 'tdcc').balance = 0;
      zeroData.liveOverlay.overlays.find(row => row.locator === 'debts:tdcc').proposedValue = 0;
      const zeroPage = await boot(zeroData, 390, theme);
      const zeroStrip = zeroPage.locator('[data-budget-card-movements]');
      await zeroStrip.waitFor();
      await zeroPage.locator('[data-budget-card-toggle="tdcc"]').click();
      const zeroPanel = zeroPage.locator('[data-budget-card-panel="tdcc"]');
      assert.equal(await zeroPanel.evaluate(el => el.firstElementChild.classList.contains('card-movement-lead')), true,
        `${theme}: the lead is the panel's first content`);
      assert.match(await leadText(zeroPanel), /^Reported balance \$0\.00/,
        `${theme}: genuine zero renders visibly as $0.00 in the lead`);
      assert.equal(await zeroPanel.locator('.card-movement-lead').isVisible(), true,
        `${theme}: the zero lead is visible, not behind the disclosure`);
      if (theme === 'light') await capture(zeroPage.locator('[data-budget-detail-sheet]'),
        'panel-lead-zero-390-light.png', { state: 'zero-balance', width: 390, theme, subject: 'sheet open, zero lead' });
      await zeroPage.keyboard.press('Escape');
      await zeroPage.close();

      const page = await boot(fx.served(), 390, theme);
      const strip = page.locator('[data-budget-card-movements]');
      await strip.waitFor();
      // Travel ordering in the current period, before the window step:
      // the re-homed "Posted through …" status follows the balance lead.
      await page.locator('[data-budget-card-toggle="travelvisa"]').click();
      await assertTravelOrder(page.locator('[data-budget-card-panel="travelvisa"]'),
        /^Posted through /, `${theme} current`);
      await page.keyboard.press('Escape');
      await page.evaluate(() => document.querySelector('[data-budget-window-step="1"]').click());
      await page.waitForFunction(s => document.querySelector('[data-budget-card-movements]')
        ?.getAttribute('data-card-period-start') === s, '2026-08-28', { timeout: 8000 });
      await page.locator('[data-budget-card-toggle="travelvisa"]').click();
      const panel = page.locator('[data-budget-card-panel="travelvisa"]');
      assert.equal(await leadText(panel), 'Reported balance Unavailable',
        `${theme}: missing balance leads with the unavailable state`);
      assert.doesNotMatch(await leadText(panel), /\$0\.00/,
        `${theme}: missing balance is never printed as an invented zero`);
      // Travel ordering in the future period, after the step's rerender:
      // the "Posted activity not observed" status follows the lead too.
      await assertTravelOrder(panel, /^Posted activity not observed$/, `${theme} future`);
      if (theme === 'dark') await capture(page.locator('[data-budget-detail-sheet]'),
        'panel-lead-unavailable-390-dark.png', { state: 'missing-balance', width: 390, theme, subject: 'sheet open, unavailable lead' });
      await page.keyboard.press('Escape');
      // Stepping back is another rerender: the current-period ordering
      // and the "Posted through …" status return, still exactly once.
      await page.evaluate(() => document.querySelector('[data-budget-window-step="-1"]').click());
      await page.waitForFunction(s => document.querySelector('[data-budget-card-movements]')
        ?.getAttribute('data-card-period-start') === s, '2026-08-14', { timeout: 8000 });
      await page.locator('[data-budget-card-toggle="travelvisa"]').click();
      await assertTravelOrder(page.locator('[data-budget-card-panel="travelvisa"]'),
        /^Posted through /, `${theme} current-after-step-back`);
      await page.keyboard.press('Escape');
      await page.close();
      states.push({ proof: 'lead-truth', width: 390, theme });
      states.push({ proof: 'travel-order', width: 390, theme, states: ['current', 'future', 'current-after-step-back'] });
    }
    // (c)+(d) keyboard and touch operation across widths and themes.
    for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark']) {
      // Keyboard: Enter opens, Tab reaches the summary, Enter expands,
      // Space collapses, Escape closes and returns focus to the trigger.
      const page = await boot(fx.served(), width, theme);
      const strip = page.locator('[data-budget-card-movements]');
      await strip.waitFor();
      const trigger = page.locator('[data-budget-card-toggle="travelvisa"]');
      const panel = page.locator('[data-budget-card-panel="travelvisa"]');
      const sheet = page.locator('[data-budget-detail-sheet]');
      await trigger.focus();
      await page.keyboard.press('Enter');
      assert.equal(await sheet.evaluate(el => el.open), true, `${width}/${theme} keyboard: Enter opens the sheet`);
      assert.equal(await leadText(panel), 'Reported balance $927.40 · Aug 20',
        `${width}/${theme} keyboard: panel leads with the published balance and its date`);
      await assertTravelOrder(panel, /^Posted through /, `${width}/${theme} keyboard`);
      assert.equal(await detailsOpen(panel), false, `${width}/${theme} keyboard: disclosure collapsed on open`);
      assert.equal(await panel.locator('details.card-movement-details > summary').innerText(),
        'Balance and payment details', `${width}/${theme} keyboard: summary label exact`);
      let summaryFocused = false;
      for (let i = 0; i < 12 && !summaryFocused; i++) {
        await page.keyboard.press('Tab');
        summaryFocused = await panel.evaluate(el => el.querySelector('details.card-movement-details > summary') === document.activeElement);
      }
      assert.equal(summaryFocused, true, `${width}/${theme} keyboard: Tab reaches the summary`);
      await page.keyboard.press('Enter');
      assert.equal(await detailsOpen(panel), true, `${width}/${theme} keyboard: Enter expands the disclosure`);
      assert.match(await panel.innerText(), /\$820\.00[\s\S]*\$927\.40/,
        `${width}/${theme} keyboard: endpoints readable verbatim once expanded`);
      await page.keyboard.press('Space');
      assert.equal(await detailsOpen(panel), false, `${width}/${theme} keyboard: Space collapses the disclosure`);
      await page.keyboard.press('Escape');
      assert.equal(await panel.isVisible(), false, `${width}/${theme} keyboard: Escape closes the sheet`);
      assert.equal(await trigger.evaluate(el => el === document.activeElement), true,
        `${width}/${theme} keyboard: focus returns to the card trigger`);
      // (d) reopen after expanding: the disclosure starts collapsed again.
      await trigger.click();
      assert.equal(await sheet.evaluate(el => el.open), true, `${width}/${theme} reopen: sheet opens again`);
      await panel.locator('details.card-movement-details > summary').click();
      assert.equal(await detailsOpen(panel), true, `${width}/${theme} reopen: disclosure expands`);
      await page.keyboard.press('Escape');
      assert.equal(await trigger.evaluate(el => el === document.activeElement), true,
        `${width}/${theme} reopen: focus returns to the trigger after close`);
      await trigger.click();
      assert.equal(await detailsOpen(panel), false,
        `${width}/${theme} reopen: disclosure is collapsed on reopen`);
      await assertTravelOrder(panel, /^Posted through /, `${width}/${theme} reopen`);
      assert.equal(await page.evaluate(() => document.querySelector('[data-budget-detail-sheet]')?.contains(document.activeElement)), true,
        `${width}/${theme} reopen: focus lands inside the sheet`);
      if (width === 390 && theme === 'light') await capture(sheet,
        'panel-open-390-light.png', { state: 'complete', width, theme, subject: 'sheet open, lead first, disclosure collapsed' });
      if (width === 1440 && theme === 'dark') await capture(sheet,
        'panel-open-1440-dark.png', { state: 'complete', width, theme, subject: 'sheet open, lead first, disclosure collapsed' });
      await page.keyboard.press('Escape');
      await page.close();

      // Touch: tap opens, tap expands/collapses, tap close dismisses.
      const touchPage = await boot(fx.served(), width, theme, true);
      const touchStrip = touchPage.locator('[data-budget-card-movements]');
      await touchStrip.waitFor();
      const touchTrigger = touchPage.locator('[data-budget-card-toggle="cashback"]');
      const touchPanel = touchPage.locator('[data-budget-card-panel="cashback"]');
      const touchSheet = touchPage.locator('[data-budget-detail-sheet]');
      await touchTrigger.tap();
      assert.equal(await touchSheet.evaluate(el => el.open), true, `${width}/${theme} touch: tap opens the sheet`);
      assert.equal(await leadText(touchPanel), 'Reported balance $2,264.20 · Aug 20',
        `${width}/${theme} touch: panel leads with the published balance and its date`);
      assert.equal(await detailsOpen(touchPanel), false, `${width}/${theme} touch: disclosure collapsed on open`);
      await touchPanel.locator('details.card-movement-details > summary').tap();
      assert.equal(await detailsOpen(touchPanel), true, `${width}/${theme} touch: tap expands the disclosure`);
      assert.match(await touchPanel.innerText(), /Opening · Aug 14[\s\S]*\$2,400\.00/,
        `${width}/${theme} touch: opening endpoint readable verbatim once expanded`);
      await touchPanel.locator('details.card-movement-details > summary').tap();
      assert.equal(await detailsOpen(touchPanel), false, `${width}/${theme} touch: tap collapses the disclosure`);
      await touchPage.locator('[data-budget-detail-close]').tap();
      assert.equal(await touchPanel.isVisible(), false, `${width}/${theme} touch: close dismisses the sheet`);
      assert.equal(await touchTrigger.evaluate(el => el === document.activeElement), true,
        `${width}/${theme} touch: focus returns to the card trigger`);
      if (width === 320 && theme === 'light') await capture(touchStrip,
        'panel-strip-320-light.png', { state: 'complete', width, theme, subject: 'card strip closed, touch context' });
      await touchPage.close();
      states.push({ proof: 'operation', width, theme, keyboard: true, touch: true, reopen: true });
    }
    // (f) Travel ordering across a rerender while the sheet is open:
    // an OS colour-scheme flip re-renders the surface (App.rerender),
    // the remount restores the Travel panel into the new dialog, and
    // the blend paint runs with Travel absent from the bento. The
    // re-homed status must still land in the Travel panel, after its
    // lead, exactly once in the document — never in another panel.
    {
      const page = await boot(fx.served(), 390, 'light');
      const strip = page.locator('[data-budget-card-movements]');
      await strip.waitFor();
      const panel = page.locator('[data-budget-card-panel="travelvisa"]');
      const cashback = page.locator('[data-budget-card-panel="cashback"]');
      await page.locator('[data-budget-card-toggle="travelvisa"]').click();
      await assertTravelOrder(panel, /^Posted through /, 'remount before');
      await page.evaluate(() => { document.querySelector('[data-budget-card-movements]').dataset.probeOld = '1'; });
      await page.emulateMedia({ colorScheme: 'dark' });
      const remounted = await page.waitForFunction(() => {
        const s = document.querySelector('[data-budget-card-movements]');
        const d = document.querySelector('[data-budget-detail-sheet]');
        const t = document.querySelector('[data-budget-card-panel="travelvisa"]');
        return !!s && !s.dataset.probeOld && !!d && d.open && !!t && d.contains(t);
      }, null, { timeout: 8000 }).then(() => true).catch(() => false);
      assert.equal(remounted, true,
        'remount: the colour-scheme flip re-rendered the surface and restored the open Travel sheet');
      await assertTravelOrder(panel, /^Posted through /, 'remount after');
      assert.equal(await cashback.evaluate(el => el.querySelectorAll('.blend-card-posted').length), 0,
        'remount after: the posted status never lands in the Cash Back panel');
      assert.equal(await page.evaluate(() => document.querySelectorAll('.blend-card-posted').length), 1,
        'remount after: the posted status exists exactly once in the document');
      await page.keyboard.press('Escape');
      await page.locator('[data-budget-card-toggle="travelvisa"]').click();
      await assertTravelOrder(panel, /^Posted through /, 'remount reopen');
      await page.keyboard.press('Escape');
      await page.close();
      states.push({ proof: 'travel-order-remount', width: 390, theme: 'light' });
    }
    assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(external, []);
    for (const shot of screenshots) shot.sha256 = sha256File(path.join(out, shot.file));
    fs.writeFileSync(path.join(out, 'proof.json'), JSON.stringify({ synthetic: true,
      generatedBy: 'test/browser-card-panel-lead.js', runtime, sourceBlobs,
      basedOn: process.env.ATLAS_PROOF_BASE || null,
      screenshots, states, errors, writes, external }, null, 2) + '\n');
    console.log(`PASS card panel lead browser proof: ${states.length} state groups, ${screenshots.length} captures`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
