'use strict';
// A1 (owner-approved audit, 1.0): stale evidence must never read as "Now" or "today".
// Real Budget page, real renderers, invented data only (the invented Budget surface
// household, observed 2026-08-20). Three cases:
//  (i)  a dated/retained view whose oldest relied-on sync was days earlier: the
//       current-period chip says "As of <day>", not "Now", and "Last updated" is that
//       older day, never a newer sync's day;
//  (ii) a tab left open past the household day (America/Vancouver) re-fetches
//       /data.json; before the day changes it does not;
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
      await page.goto('http://budget.test/');
      await page.locator(ready).first().waitFor({ state: 'attached' });
      if (ready === '[data-blend-rings]') await page.locator('[data-budget-surface]').waitFor();
      return { page, requests };
    };
    const chip = page => page.evaluate(() => {
      const node = document.querySelector('.blend-now');
      return node ? { text: node.textContent.trim(), dated: node.getAttribute('data-blend-now-dated') } : null;
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

    // (ii) A tab left open past the household day re-fetches. Vancouver is UTC-7 in August:
    // 2026-08-20T20:00Z is 13:00 Aug 20; +2h is still Aug 20; 2026-08-21T08:00Z is 01:00 Aug 21.
    {
      const next = clone(fresh);
      next.meta.asOf = '2026-08-21';
      const { page, requests } = await open([fresh, next], { clockAt: '2026-08-20T20:00:00Z' });
      ok(requests.data === 1, 'one data request on first load', String(requests.data));
      await page.clock.fastForward('02:00:00');
      await page.waitForTimeout(200);
      ok(requests.data === 1, 'later the same household day: no reload', String(requests.data));
      await page.clock.fastForward('10:00:00');
      await page.waitForFunction(() => true);
      await page.waitForTimeout(500);
      ok(requests.data >= 2, 'past the household day: the page re-fetches /data.json', String(requests.data));
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
    assert.deepEqual(errors, [], 'no page errors');
    assert.deepEqual(external, [], 'no external requests');
    assert.deepEqual(writes, [], 'no writes');
    console.log(`PASS stale evidence never reads as Now or today: ${checks} checks`);
  } finally { await browser.close(); }
})().catch(err => { console.error(err); process.exit(1); });
