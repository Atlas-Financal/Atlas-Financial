'use strict';
/* The Savings goals card without the old funding-proposal panel, and no
 * card tilt (Grok's live UI audit 2026-11-11, item A; owner decision,
 * Dale 2026-11-11: hidden old-Atlas surfaces are removed, not fixed).
 * `node test/browser-budget-goals-card.js`  (CHROME_PATH=<Chromium> optional)
 *
 * Clicking the Savings goals header used to expand plan.js's old "Upcoming
 * costs & savings" section (Funding proposal / Costs ahead / Where it comes
 * from) inside the card, in columns so narrow that goal names printed one
 * letter per line. That section and its disclosure leave the live page; the
 * card face, its goal windows and "Accounts & evidence" stay.
 *
 * Through the real page at 1440px and 390px (touch), this proves:
 *   1. the funding-proposal section is not in the live page and none of its
 *      headings print; there is no savings-detail disclosure;
 *   2. the Savings goals header is a plain heading: not a button, it controls
 *      nothing, and clicking it changes nothing on the page;
 *   3. every goal row, and every goal window it opens (title and body), reads
 *      exactly as on main: compared with test/fixtures/goals-card-main.json,
 *      captured from main on the same invented fixture;
 *   4. "Accounts & evidence" is on the card face and opens its dialog;
 *   5. no card tilts under the pointer: no .blend-tilt, and a card's
 *      transform stays none while the pointer moves across it.
 *
 * Invented fixture only (test/fixtures/budget-surface-data.js).
 * CAPTURE=1 ROOT=<checkout> writes the snapshot from another checkout.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');
const { data: paidFixture } = require('./fixtures/savings-goal-paid-progress-data');

const root = process.env.ROOT ? path.resolve(process.env.ROOT) : path.join(__dirname, '..');
const SNAPSHOT = path.join(__dirname, 'fixtures', 'goals-card-main.json');
const WIDTHS = [[1440, false], [390, true]];
// Invented cases: the plain Budget fixture (goal values unavailable) and
// the paid-progress fixture with qualified evidence and with funding gaps,
// so saved, needed, paid, still-to-fund and top-up values are all printed.
const CASES = [
  ['budget-surface', () => fx.served({})],
  ['paid-evidence', () => paidFixture('evidence')],
  ['paid-gap', () => paidFixture('gap')],
];
let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

async function open(browser, width, touch, data) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: touch, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== 'http://budget.test') return route.abort();
    if (u.pathname === '/data.json') return route.fulfill({ json: data() });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
    const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript'
      : file.endsWith('.png') ? 'image/png' : file.endsWith('.woff2') ? 'font/woff2'
      : file.endsWith('.woff') ? 'font/woff' : 'text/html';
    return route.fulfill({ body: fs.readFileSync(file), contentType: type });
  });
  await page.goto('http://budget.test/');
  await page.locator('[data-budget-surface]').waitFor();
  await page.locator('[data-budget-savings-goals]').waitFor();
  await page.waitForTimeout(400);
  return { page, context, errors };
}

const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

// Every goal row's printed text, and the window each one opens.
async function readGoals(page, touch) {
  const rows = page.locator('[data-budget-savings-goals] [data-blend-goal]');
  const count = await rows.count();
  const out = [];
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const rowText = norm(await row.innerText());
    await row.scrollIntoViewIfNeeded();
    if (touch) await row.tap(); else await row.click();
    const dialog = page.locator('dialog[open]');
    await dialog.first().waitFor({ timeout: 3000 }).catch(() => {});
    const win = (await dialog.count()) ? norm(await dialog.first().innerText()) : null;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    out.push({ row: rowText, window: win });
  }
  return out;
}

(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const captured = {};
  try {
    for (const [name, data] of CASES) for (const [width, touch] of WIDTHS) {
      const where = `${name}, ${width}px${touch ? ' touch' : ''}`;
      const key = name + '@' + width;
      const { page, context, errors } = await open(browser, width, touch, data);
      if (process.env.CAPTURE) {
        captured[key] = await readGoals(page, touch);
        await context.close();
        continue;
      }
      console.log(`\n=== ${where} ===`);
      const card = page.locator('[data-budget-savings-goals]');

      // 1. The funding-proposal section is gone from the live page.
      const gone = await page.evaluate(() => ({
        section: document.querySelectorAll('[data-budget-funding-section]').length,
        panel: document.querySelectorAll('.blend-goals-panel, #blend-savings-detail').length,
        words: /Funding proposal|Costs ahead|Where it comes from|Upcoming costs & savings/i.test(document.body.innerText),
      }));
      ok(gone.section === 0, 'the funding-proposal section is not in the live page');
      ok(gone.panel === 0, 'there is no savings-detail disclosure');
      ok(!gone.words, 'none of its headings print on the page');

      // 2. The header is a plain heading and clicking it changes nothing.
      const head = card.locator('.blend-tile-head');
      const headFacts = await head.evaluate(el => ({ tag: el.tagName, role: el.getAttribute('role'),
        controls: el.getAttribute('aria-controls'), expanded: el.getAttribute('aria-expanded') }));
      ok(headFacts.tag !== 'BUTTON' && !headFacts.role && !headFacts.controls && headFacts.expanded == null,
        'the Savings goals header is a plain heading that controls nothing', JSON.stringify(headFacts));
      const before = await page.evaluate(() => ({ text: document.body.innerText, h: document.querySelector('[data-budget-savings-goals]').getBoundingClientRect().height }));
      await head.scrollIntoViewIfNeeded();
      if (touch) await head.tap(); else await head.click();
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => ({ text: document.body.innerText, h: document.querySelector('[data-budget-savings-goals]').getBoundingClientRect().height,
        open: document.querySelectorAll('dialog[open]').length }));
      ok(after.text === before.text && Math.abs(after.h - before.h) < 1 && after.open === 0,
        'clicking the header expands and opens nothing');

      // 3. Goal rows and their windows read exactly as on main.
      const goals = await readGoals(page, touch);
      const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'))[key] || [];
      ok(goals.length > 0 && goals.length === snapshot.length, 'the same goal rows as on main', `${goals.length} vs ${snapshot.length}`);
      goals.forEach((g, i) => {
        const want = snapshot[i] || {};
        ok(g.row === want.row, `goal row ${i + 1} reads as on main`);
        ok(g.window != null && g.window === want.window, `goal window ${i + 1} reads as on main`);
      });

      // 4. Accounts & evidence stays on the card face and opens its dialog.
      const inventory = card.locator('[data-budget-funding-inventory]');
      ok(await inventory.count() === 1 && await inventory.isVisible(), '"Accounts & evidence" is on the card face');
      if (await inventory.count()) {
        await inventory.scrollIntoViewIfNeeded();
        if (touch) await inventory.tap(); else await inventory.click();
        const sheet = page.locator('[data-budget-detail-sheet][open]');
        await sheet.waitFor({ timeout: 3000 }).catch(() => {});
        ok(await sheet.count() === 1 && norm(await sheet.innerText()).length > 0, 'it opens its dialog');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
      }

      // 5. No tilt under the pointer.
      const tilts = await page.evaluate(() => document.querySelectorAll('.blend-tilt').length);
      ok(tilts === 0, 'no card carries the tilt class');
      if (!touch) {
        const box = await card.boundingBox();
        await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.1);
        await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.9, { steps: 5 });
        const transform = await card.evaluate(el => getComputedStyle(el).transform);
        ok(transform === 'none', 'a card does not rotate while the pointer moves across it', transform);
      }
      ok(errors.length === 0, 'no page errors', errors.length ? String(errors.length) : '');
      await context.close();
    }
  } finally {
    await browser.close();
  }
  if (process.env.CAPTURE) {
    fs.writeFileSync(SNAPSHOT, JSON.stringify(captured, null, 1) + '\n');
    console.log('captured ' + SNAPSHOT);
    return;
  }
  console.log(`\n${checks} checks, ${failures} failed`);
  if (failures) process.exit(1);
  console.log('The Savings goals card keeps its goals and drops the old funding panel.');
})().catch(err => { console.error(err); process.exit(1); });
