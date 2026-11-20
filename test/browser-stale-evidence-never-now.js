'use strict';
// A1 (owner-approved audit, 1.0): stale evidence must never read as "Now" or "today".
// Real Budget page, real renderers, invented data only (the invented Budget surface
// household, observed 2026-08-20). Three cases:
//  (i)  a dated/retained view whose oldest relied-on sync was days earlier: the
//       current-period chip says "As of <day>", not "Now", and "Last updated" is that
//       older day, never a newer sync's day;
//  (ii) a tab left open past the household day (America/Vancouver) never reloads or
//       fetches by itself, hidden or not: it marks itself dated (chip "As of <day>", a
//       notice with a Reload button) and only a click reloads;
//  (iii) after a failed refresh the Bills balance is dated by its own row: the old
//       $15.00 opening is "dated August 13", never beside a newer observation's date.
// No visible "Now", "Last updated" or "dated" day may be later than the evidence it
// describes. The Nov 10 owner rule is kept: sync age alone never blanks a figure.
// NODE_PATH=<Playwright modules> CHROME_PATH=<Chromium> node test/browser-stale-evidence-never-now.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');
const root = path.join(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const errors = [], external = [], writes = [];
  let checks = 0;
  const ok = (cond, label, detail) => { assert.ok(cond, label + (detail ? ' - ' + detail : '')); checks++; };
  try {
    // `bodies` is a queue: each /data.json request takes the next entry (the last repeats).
    const open = async (bodies, { clockAt, ready = '[data-blend-rings]' } = {}) => {
      const page = await browser.newPage({ viewport: { width: 390, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce' });
      const requests = { data: 0 };
      page.on('pageerror', err => errors.push(err.message));
      if (clockAt) await page.clock.install({ time: new Date(clockAt) });
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (route.request().method() !== 'GET') { writes.push(u.pathname); return route.abort(); }
        if (u.origin !== 'http://budget.test') { external.push(u.origin); return route.abort(); }
        if (u.pathname === '/data.json') {
          const body = bodies[Math.min(requests.data, bodies.length - 1)];
          requests.data++;
          return route.fulfill({ json: body });
        }
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
        const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file),
          contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      });
      await page.goto('http://budget.test/?view=classic');
      await page.locator(ready).first().waitFor({ state: 'attached' });
      if (ready === '[data-blend-rings]') await page.locator('[data-budget-surface]').waitFor();
      return { page, requests };
    };
    const chip = page => page.evaluate(() => {
      const node = document.querySelector('.blend-now');
      return node ? { text: node.textContent.trim(), dated: node.getAttribute('data-blend-now-dated') } : null;
    });
    // The live dot is drawn by a ::before on the chip (public/budget-polish.css, B6). A chip
    // that names a past day must draw none: a live mark beside "As of" would dress old
    // figures as current.
    const liveDot = page => page.evaluate(() => {
      const node = document.querySelector('.blend-now');
      if (!node) return null;
      const mark = getComputedStyle(node, '::before');
      return { drawn: mark.content !== 'none' && mark.content !== 'normal', animation: mark.animationName };
    });
    const lastUpdated = page => page.evaluate(() => (document.querySelector('[data-account-last-updated]')?.textContent || '').replace(/\s+/g, ' ').trim());

    // The invented household as served on its observation day (2026-08-20).
    const fresh = fx.served();
    const OBS = '2026-08-20';
    ok(fresh.meta.asOf === OBS, 'control: the invented feed is observed on 2026-08-20', fresh.meta.asOf);

    // (i) Fresh feed: every relied-on account synced the same day. "Now" is true and shown.
    const freshSynced = clone(fresh);
    freshSynced.liveOverlay.currentPeriodActuals.lastSuccessfulSyncAt = '2026-08-20T17:55:00.000Z';
    {
      const { page } = await open([freshSynced]);
      const c = await chip(page);
      ok(c && c.text === 'Now' && c.dated == null, 'fresh feed: the current-period chip says Now', JSON.stringify(c));
      const dot = await liveDot(page);
      ok(dot && dot.drawn === true, 'control: the fresh Now chip draws its live dot', JSON.stringify(dot));
      ok(/Aug(ust)? 20/.test(await lastUpdated(page)), 'fresh feed: Last updated is the evidence day', await lastUpdated(page));
      await page.close();
    }

    // (i) Dated view: the chequing feed last synced Aug 17, a card synced Aug 20. The server
    // reports the oldest relied-on sync (Aug 17) and marks the answer retained/dated.
    const stale = clone(fresh);
    stale.liveOverlay.currentPeriodActuals.lastSuccessfulSyncAt = '2026-08-17T17:55:00.000Z';
    stale.liveOverlay.retainedRefresh = { source: 'provider', qualified: false, observedAt: '2026-08-17T17:55:00.000Z',
      checkedAt: '2026-08-20T18:00:00.000Z', reason: 'stale-live-cash-evidence' };
    {
      const { page } = await open([stale]);
      const c = await chip(page);
      ok(c && /^As of Aug 20$/.test(c.text) && c.dated === OBS, 'dated view: the chip names its evidence day instead of Now', JSON.stringify(c));
      const dot = await liveDot(page);
      ok(dot && dot.drawn === false && dot.animation === 'none', 'dated view: the As of chip draws no live dot and has no motion', JSON.stringify(dot));
      const body = await page.evaluate(() => document.body.innerText);
      ok(!/\bNow\b/.test(await page.evaluate(() => document.querySelector('.blend-hero-top')?.innerText || '')),
        'dated view: no Now in the current-period header');
      const updated = await lastUpdated(page);
      ok(/Aug(ust)? 17/.test(updated) && !/Aug(ust)? 20/.test(updated),
        'dated view: Last updated is the oldest relied-on sync (Aug 17), not the newer card sync', updated);
      // Sync age alone never blanks a figure (Nov 10 owner rule): the Budget still prints money.
      ok(/\$[\d,]+\.\d\d/.test(body) && await page.locator('[data-budget-surface]').count() === 1,
        'sync age alone does not blank the figures');
      await page.close();
    }

    // (ii) A tab left open past the household day never reloads or fetches by itself. It marks
    // itself dated (the chip reads As of Aug 20, a notice offers Reload for today), and only a click
    // reloads. Vancouver is UTC-7 in August: 2026-08-20T20:00Z is 13:00 Aug 20; +2h is still Aug 20;
    // +10h more is 01:00 Aug 21.
    {
      const next = clone(fresh);
      next.meta.asOf = '2026-08-21';
      const { page, requests } = await open([fresh, next], { clockAt: '2026-08-20T20:00:00Z' });
      ok(requests.data === 1, 'one data request on first load', String(requests.data));
      await page.evaluate(() => { window.__loadedMarker = 'first-load'; });
      const everything = () => page.evaluate(() => performance.getEntriesByType('resource').length);
      const resources = await everything();
      const state = () => page.evaluate(() => ({
        marker: window.__loadedMarker || null,
        notice: !!document.querySelector('[data-page-day-notice]'),
        noticeVisible: (() => { const n = document.querySelector('[data-page-day-notice]'); return !!n && n.getBoundingClientRect().height > 0; })(),
        chip: document.querySelector('.blend-now')?.textContent.trim() || null }));
      await page.clock.fastForward('02:00:00');
      await page.waitForTimeout(200);
      let st = await state();
      ok(requests.data === 1 && st.marker === 'first-load' && !st.notice && st.chip === 'Now',
        'later the same household day: no request, no reload, no notice, chip still Now', JSON.stringify(st));
      // The tab is hidden across midnight: nobody is there.
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      });
      await page.clock.fastForward('10:00:00');
      await page.waitForTimeout(500);
      st = await state();
      ok(requests.data === 1 && await everything() === resources && st.marker === 'first-load',
        'a hidden tab across the household day makes zero requests to /data.json or any route, and does not reload',
        JSON.stringify({ data: requests.data, resources: await everything(), was: resources, marker: st.marker }));
      // The person comes back: the page says it is old and still does nothing by itself.
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForTimeout(300);
      await page.clock.fastForward('00:10:00');
      await page.waitForTimeout(300);
      st = await state();
      ok(st.noticeVisible && st.chip === 'As of Aug 20' && st.marker === 'first-load' && requests.data === 1 && await everything() === resources,
        'back on the tab: a visible notice, the chip reads As of Aug 20, and still no reload and no request', JSON.stringify(st));
      const passedDot = await liveDot(page);
      ok(passedDot && passedDot.drawn === false && passedDot.animation === 'none',
        'page left open past the day: the chip markPageDated dated draws no live dot and has no motion', JSON.stringify(passedDot));
      const noticeText = await page.locator('[data-page-day-notice]').innerText();
      ok(/^This page is from Aug 20\. Reload for today$/.test(noticeText.replace(/\s+/g, ' ').trim()), 'the notice reads: This page is from Aug 20. Reload for today', noticeText);
      // Only a click reloads, after the same confirmation as the "Reload Atlas" notice: Cancel reloads nothing.
      let confirmText = null;
      page.once('dialog', dialog => { confirmText = dialog.message(); dialog.dismiss(); });
      await page.locator('[data-page-day-reload]').click();
      await page.waitForTimeout(300);
      st = await state();
      ok(/^Reload now\? Unsaved input/.test(confirmText || '') && requests.data === 1 && st.marker === 'first-load',
        'Cancel in the confirmation reloads nothing', String(confirmText));
      page.once('dialog', dialog => dialog.accept());
      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.locator('[data-page-day-reload]').click()]);
      await page.locator('[data-blend-rings]').first().waitFor({ state: 'attached' });
      st = await state();
      ok(requests.data === 2 && st.marker === null && !st.notice,
        'a click on Reload for today reloads once: a second /data.json request, a fresh page, no notice', JSON.stringify({ data: requests.data, st }));
      await page.close();
    }

    // (iii) After a failed refresh the old Bills balance keeps its own date.
    {
      const failed = fx.served({ unavailablePlan: true });
      const { page } = await open([failed], { ready: '[data-bills-closing]' });
      const line = await page.evaluate(() => [...document.querySelectorAll('[data-bills-closing] .operating-note')]
        .map(n => n.textContent.replace(/\s+/g, ' ').trim()).find(t => /Latest recorded Bills balance/.test(t)) || null);
      ok(line && /\$15\.00, dated August 13\b/.test(line) && !/August 20/.test(line),
        'failed refresh: the old $15.00 opening is dated August 13, never beside August 20', String(line));
      await page.close();
    }
    // (iii-b) With no plan opening date, the printed Latest recorded line says Unavailable with its reason
    // and no amount (a balance is never shown without its date): the line the household reads, not Forecast's output.
    {
      const undated = fx.served({ unavailablePlan: true });
      delete undated.plan.opening.asOf;
      const { page } = await open([undated], { ready: '[data-bills-closing]' });
      const line = await page.evaluate(() => [...document.querySelectorAll('[data-bills-closing] .operating-note')]
        .map(n => n.textContent.replace(/\s+/g, ' ').trim()).find(t => /Latest recorded Bills balance/.test(t)) || null);
      ok(line && /^Latest recorded Bills balance: Unavailable\. A dated posted Bills account balance is unavailable/.test(line) && !/\$\d/.test(line),
        'no plan opening date: the printed line says Unavailable with its reason and no amount', String(line));
      await page.close();
    }
    assert.deepEqual(errors, [], 'no page errors');
    assert.deepEqual(external, [], 'no external requests');
    assert.deepEqual(writes, [], 'no writes');
    console.log(`PASS stale evidence never reads as Now or today: ${checks} checks`);
  } finally { await browser.close(); }
})().catch(err => { console.error(err); process.exit(1); });
