'use strict';
// "Saved history unavailable" must be SEEN. When the saved period-history archive is in use but
// cannot be read, a completed period is rebuilt from today's plan and the page says so. The first
// version printed that notice inside the Budget window header, which the active layout hides
// (budget-blend.js sets it hidden; budget-gface.css forces display:none), so no household member
// ever saw it. The node tests prove the wording and the marker through the page's renderers; this
// is the browser path: the real page, reached the way a person reaches it (the Pay period slider,
// ArrowLeft), at both widths, asserting the notice has a box and is in the visible page text, on the
// surface and in every sheet opened from its own control, and that the current period and a period
// with its saved close carry none.
//
// Invented data only (test/fixtures/private-period-history-input: cycle Feb 1-14 2030, groceries 40,
// income 200, an invented $30 bill; the close is saved Feb 16 and read Feb 20).
// `node test/browser-saved-history-unavailable.js`
// (Playwright browser suite; not part of the node manifest, see test/test.js).
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const History = require('../scripts/private-period-history');
const Pg = require('../scripts/private-period-history-postgres');
const { START, NEXT, input } = require('./fixtures/private-period-history-input');

const root = path.join(__dirname, '..');
const bill = () => [{ id: 'invented-bill', label: 'Invented bill', frequency: 'monthly', day: 10, amount: 30,
  confidence: 'confirmed', payingAccount: 'chequing-a' }];
const closeRaw = input({ day: '2030-02-16', kind: 'closing', periodStart: START, bills: bill() });
delete closeRaw.kind; delete closeRaw.periodStart;
const capturedAt = closeRaw.capturedAt; delete closeRaw.capturedAt;
const record = Pg.project(History.captureClosing(JSON.parse(JSON.stringify(closeRaw)), { now: () => new Date(capturedAt) }));
const today = input({ day: '2030-02-20', kind: 'first-observed', periodStart: NEXT, bills: bill() }).data;
const NOTICE = /Saved history unavailable\. This period is rebuilt from today's plan, not the saved close\./;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  let checks = 0;
  const ok = (cond, label, detail) => { assert.ok(cond, label + (detail ? ' - ' + detail : '')); checks++; };
  try {
    for (const width of [1440, 390]) {
      for (const scenario of ['read failed', 'first load', 'saved close present', 'archive healthy, no close']) {
        // read failed / first load: the archive is in use and cannot be read; the notice is expected.
        // saved close present: the failure status stands but this period HAS its saved close (none expected).
        // archive healthy, no close: nothing is stated (the legacy pre-archive rebuild is unchanged).
        const data = { ...today };
        if (scenario === 'read failed') data.periodHistoryStatus = { status: 'unavailable', reason: 'history-read-failed' };
        if (scenario === 'first load') data.periodHistoryStatus = { status: 'unavailable', reason: 'history-not-loaded' };
        if (scenario === 'saved close present') { data.periodHistory = [record]; data.periodHistoryStatus = { status: 'unavailable', reason: 'history-read-failed' }; }
        const expectNotice = scenario === 'read failed' || scenario === 'first load';
        const tag = `${width}px ${scenario}`;
        const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce' });
        const errors = [], external = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.route('**/*', route => {
          const u = new URL(route.request().url());
          if (u.origin !== 'http://budget.test') { external.push(u.origin); return route.abort(); }
          if (u.pathname === '/data.json') return route.fulfill({ json: data });
          if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
          const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
          if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
          return route.fulfill({ body: fs.readFileSync(file),
            contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
        });
        await page.goto('http://budget.test/');
        await page.locator('.river').waitFor();
        const start = () => page.evaluate(() => document.querySelector('[data-budget-window-progress]')?.dataset.start || null);
        // What a person can actually see of the notice: a real box AND its words in the visible text.
        const seen = selector => page.evaluate(sel => [...document.querySelectorAll(sel)].some(node => {
          const box = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
            && !node.closest('[hidden]') && /Saved history unavailable\./.test(node.innerText);
        }), selector);
        const surface = '[data-budget-saved-history-unavailable="surface"]';
        const sheetNotice = '[data-budget-saved-history-unavailable="sheet"]';

        // The current period is live and never a saved close: no notice, whatever the archive status.
        ok(!await seen(surface), `${tag}: the current period shows no notice`);

        for (let i = 0; i < 6 && await start() !== START; i++) {
          const was = await start();
          await page.locator('.river').focus();
          await page.keyboard.press('ArrowLeft');
          await page.waitForFunction(s => document.querySelector('[data-budget-window-progress]')?.dataset.start !== s, was, { timeout: 5000 });
        }
        ok(await start() === START, `${tag}: the slider reaches the completed period Feb 1-14`);

        if (expectNotice) {
          ok(await seen(surface), `${tag}: the notice has a box and is in the visible text on the Budget page`);
          const pageText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
          ok(NOTICE.test(pageText), `${tag}: the visible page text says Saved history unavailable`);
          ok(!/Shown as captured when this period closed/.test(pageText), `${tag}: the rebuild is never presented as the saved close`);
        } else {
          ok(!await seen(surface), `${tag}: no notice is shown`);
        }

        // Every sheet opened from its own control carries the same notice (or none).
        const body = page.locator('[data-budget-detail-body]');
        for (const number of ['06', '02', '04']) {
          const trigger = page.locator(`[data-operating-question="${number}"] > details > summary`);
          await trigger.focus(); await page.keyboard.press('Enter');
          await page.waitForFunction(() => document.querySelector('[data-budget-detail-sheet]')?.open);
          const sheetSeen = await seen(sheetNotice);
          const dialogText = (await page.locator('[data-budget-detail-sheet]').innerText()).replace(/\s+/g, ' ');
          if (expectNotice) ok(sheetSeen && NOTICE.test(dialogText), `${tag}: the sheet ${number} shows the notice`);
          else ok(!sheetSeen && !NOTICE.test(dialogText), `${tag}: the sheet ${number} shows no notice`);
          await body.evaluate(el => el.scrollTop = 0);
          await page.keyboard.press('Escape');
          await page.waitForFunction(() => !document.querySelector('[data-budget-detail-sheet]')?.open);
        }
        assert.deepEqual(errors, [], `${tag}: no page errors`);
        assert.deepEqual(external, [], `${tag}: no external requests`);
        await page.close();
      }
    }
    // The Savings goal explanation is its own modal (budget-blend.js explainGoal -> explainOpen), outside
    // the detail-sheet controller. It must carry the notice too (second blocker on #1148). The invented
    // Budget surface household (School trip, Winter tires) with an unreadable archive, a past period selected.
    const fx = require('./fixtures/budget-surface-data');
    for (const width of [1440, 390]) {
      const data = fx.served();
      data.periodHistoryStatus = { status: 'unavailable', reason: 'history-read-failed' };
      const tag = `${width}px goal window`;
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 }, colorScheme: 'light', reducedMotion: 'reduce' });
      const errors = [], external = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.origin !== 'http://budget.test') { external.push(u.origin); return route.abort(); }
        if (u.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
        const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file),
          contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      });
      await page.goto('http://budget.test/');
      await page.locator('.river').waitFor();
      const goals = () => page.locator('[data-blend-goals] .blend-goal-legend > li button.blend-goal-row');
      const startNow = () => page.evaluate(() => document.querySelector('[data-budget-window-progress]')?.dataset.start || null);
      // Select the completed period just before the current one.
      const was = await startNow();
      await page.locator('.river').focus();
      await page.keyboard.press('ArrowLeft');
      await page.waitForFunction(s => document.querySelector('[data-budget-window-progress]')?.dataset.start !== s, was, { timeout: 5000 });
      ok(await page.locator('[data-budget-saved-history-unavailable="surface"]').count() === 1, `${tag}: the selected completed period carries the surface notice`);
      if (await goals().count()) {
        await goals().first().click();
        await page.waitForFunction(() => document.querySelector('[data-blend-explain]')?.open);
        const inModal = await page.evaluate(() => {
          const node = document.querySelector('[data-blend-explain] [data-budget-saved-history-unavailable="explain"]');
          if (!node) return null;
          const box = node.getBoundingClientRect();
          return { width: box.width, height: box.height, text: node.innerText };
        });
        ok(inModal && inModal.width > 0 && inModal.height > 0 && /Saved history unavailable\./.test(inModal.text),
          `${tag}: the Savings goal window shows the notice with a real box`, JSON.stringify(inModal));
        await page.keyboard.press('Escape');
      } else {
        ok(false, `${tag}: the fixture offers a Savings goal row to open`);
      }
      assert.deepEqual(errors, [], `${tag}: no page errors`);
      assert.deepEqual(external, [], `${tag}: no external requests`);
      await page.close();
    }
    console.log(`PASS saved history unavailable is seen: ${checks} checks`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
