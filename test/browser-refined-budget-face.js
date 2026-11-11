'use strict';
// Refined Budget, step 1 "tidy the face" (#821, owner 2026-11-11). Display
// only. Real App.boot and the real Budget renderer on invented inputs; only
// intercepted invented GETs, no external requests, no writes.
//   1. "Last updated" beside the logo is a verbatim copy of the Budget's
//      printed footer line, and absent when no footer line is printed.
//   2. "Accounts & evidence" is off the face and opens from the savings
//      detail; its dialog opens and returns focus to it.
//   3. Savings-goal bars carry no pink: filled bars are green, an unknown
//      share has no fill and a hatched track; the goals icon is green.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { data: paidFixture } = require('./fixtures/savings-goal-paid-progress-data');
const Fixture = require('./fixtures/budget-surface-data');
const Live = require('../scripts/live-plan');
const root = path.resolve(__dirname, '..'), assets = path.join(root, 'public');
const ORIGIN = 'http://refined-face.test';
const errors = [], external = [], writes = [];
let checks = 0, unknownBars = 0, filledBars = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); checks++; };
const yes = (v, m) => { assert.ok(v, m); checks++; };

const SYNC = '2026-08-20T17:30:00.000Z';
const synced = (() => {
  const p = Fixture.payload(); p.accounts.forEach(a => { a.plaid_last_successful_update = SYNC; });
  const e = console.error; console.error = () => {};
  try { return Live.fromObservation({ data: Fixture.canonical(), payload: p, accountMap: Fixture.map, identity: Fixture.identity }).data; }
  finally { console.error = e; }
})();
// Independent expectation for the footer text (not the page's formatter).
const expectedTime = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: 'short',
  day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(SYNC));

async function open(browser, data, width) {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) { external.push(url.origin); return route.abort(); }
    if (route.request().method() !== 'GET') { writes.push(route.request().method()); return route.abort(); }
    if (url.pathname === '/data.json') return route.fulfill({ json: data });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return route.fulfill({ json: null });
    const file = path.resolve(assets, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(assets + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ body: fs.readFileSync(file),
      contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto(ORIGIN + '/');
  await page.locator('[data-budget-savings-goals] [data-blend-goals]').waitFor();
  return page;
}
const rgb = value => (String(value).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
const greenish = value => { const [r, g, b] = rgb(value); return g > r && g >= b * 0.9; };
const pinkish = value => { const [r, g, b] = rgb(value); return r > g + 40 && b > g; };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  try {
    for (const width of [1440, 390]) {
      // 1. Header line: verbatim copy of the printed footer, never re-derived.
      const page = await open(browser, synced, width);
      const footer = page.locator('#operating-surface [data-account-last-updated]');
      const header = page.locator('.site-head .blend-brand > [data-blend-updated]');
      const footerText = (await footer.innerText()).trim();
      eq(footerText, 'Last updated ' + expectedTime, `${width}: footer prints the successful-sync instant`);
      eq((await header.innerText()).trim(), footerText, `${width}: header line is the printed footer text, verbatim`);
      eq(await header.getAttribute('aria-hidden'), 'true', `${width}: header copy is not announced twice`);
      yes(await footer.evaluate(n => n.classList.contains('blend-clip')), `${width}: footer stays in the document as the read-out`);
      yes(await header.isVisible(), `${width}: header line is visible beside the logo`);
      const fits = await page.evaluate(() => [...document.querySelectorAll('.site-head-inner > *')]
        .every(n => { const r = n.getBoundingClientRect(); return r.width === 0 || (r.left >= 0 && r.right <= innerWidth + 0.5); }));
      yes(fits, `${width}: header row fits the viewport (no control pushed off)`);
      await page.close();
      // No printed footer line: no header line (nothing invented).
      const quiet = await open(browser, paidFixture('evidence'), width);
      eq(await quiet.locator('#operating-surface [data-account-last-updated]').count(), 0, `${width}: invented packet without sync prints no footer`);
      eq(await quiet.locator('.site-head [data-blend-updated]').count(), 0, `${width}: no footer, no header line`);

      // 2. Accounts & evidence: off the face, reachable from the savings detail.
      const tile = quiet.locator('[data-budget-savings-goals]');
      const inventory = tile.locator('[data-budget-funding-inventory]');
      eq(await inventory.count(), 1, `${width}: the one Accounts & evidence button is kept`);
      eq(await inventory.isVisible(), false, `${width}: not on the face`);
      yes(await inventory.evaluate(n => !!n.closest('.blend-goals-panel')), `${width}: it lives in the savings detail`);
      await tile.locator('.blend-tile-head').click();
      yes(await inventory.isVisible(), `${width}: the savings detail shows it`);
      await inventory.focus(); await quiet.keyboard.press('Enter');
      const dialog = quiet.locator('[data-budget-detail-sheet]'); await dialog.waitFor({ state: 'visible' });
      yes(/Accounts/i.test(await dialog.innerText()) || (await dialog.innerText()).length > 0, `${width}: the dialog opens`);
      await quiet.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
      yes(await inventory.evaluate(n => document.activeElement === n), `${width}: focus returns to Accounts & evidence`);
      await quiet.close();

      // 3. Goal bars and icon: green, no pink; unknown is hatched with no fill.
      for (const mode of ['evidence', 'absent', 'uncertain', 'gap']) {
        const p = await open(browser, paidFixture(mode), width);
        // Any CSS colour (rgb, oklab, color-mix result) read back as sRGB through one canvas pixel.
        const bars = await p.locator('[data-blend-goals] .blend-g-bar').evaluateAll(list => {
          const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
          const srgb = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
            const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data; return `rgba(${r}, ${g}, ${b}, ${a})`; };
          return list.map(bar => {
            const before = getComputedStyle(bar, '::before');
            const raw = before.backgroundColor;
            return { band: [...bar.classList].find(c => c.startsWith('is-')), raw,
              fill: /^rgba\(0, 0, 0, 0\)$|transparent/.test(raw) ? raw : srgb(raw),
              track: getComputedStyle(bar).backgroundImage, width: parseFloat(before.width) };
          });
        });
        yes(bars.length > 0, `${mode} ${width}: goal bars rendered`);
        for (const bar of bars) {
          yes(!pinkish(bar.fill), `${mode} ${width} ${bar.band}: no pink fill (${bar.fill})`);
          if (bar.band === 'is-unknown') { unknownBars++;
            yes(/rgba\(0, 0, 0, 0\)|transparent/.test(bar.raw), `${mode} ${width}: unknown share has no fill`);
            yes(/repeating-linear-gradient/.test(bar.track), `${mode} ${width}: unknown share has a hatched track`);
          } else if (bar.band !== 'is-no-funding-required' && bar.width > 0) { filledBars++;
            yes(greenish(bar.fill), `${mode} ${width} ${bar.band}: filled bar is green (${bar.fill})`);
          }
        }
        const icon = await p.locator('[data-budget-savings-goals] .blend-tile-ico, [data-budget-savings-goals] .blend-tile-head svg').first()
          .evaluate(n => { const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
            ctx.fillStyle = getComputedStyle(n).color; ctx.fillRect(0, 0, 1, 1); const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
            return `rgb(${r}, ${g}, ${b})`; });
        yes(greenish(icon) && !pinkish(icon), `${mode} ${width}: goals icon is green (${icon})`);
        await p.close();
      }
    }
    yes(unknownBars > 0 && filledBars > 0, `non-vacuous: ${unknownBars} unknown and ${filledBars} filled bars checked`);
    eq(errors, [], 'no page errors'); eq(external, [], 'no external requests'); eq(writes, [], 'no writes');
    console.log('PASS refined Budget face (step 1): ' + checks + ' checks');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
