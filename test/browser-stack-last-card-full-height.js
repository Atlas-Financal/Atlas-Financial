'use strict';
/* Every closed card in the Stack pile is the same full height, wherever it sits, the last one included (Dale, 2026-11-25:
 * "What ever happened to fixing the bottom stack? It's still shorter than the others."). Before: stack.css gave the Credit
 * card its 56px foot only when it was not the last slot, and stack-cards.css cut the last .sc-card's foot to 22px, so
 * whichever card was moved to the bottom (#1629) read 34px shorter.
 *
 * A real browser at 390 and 320 wide, the real public/ files, invented data only (test/fixtures/bills-period-end-balance-data.js,
 * served for /data.json by route interception; no server, no household data):
 *   1. In the default order, and with Credit, the Bills account card and the Budget card each moved last: every closed card
 *      (Credit included) has the same getBoundingClientRect().height, and the last card is the one moved there.
 *   2. The page end: the last card's foot is inside the page (the document scrolls to show it all), and nothing scrolls sideways.
 *   3. Mutant: serving the two old trims back makes the last card shorter, and the check in 1 rejects it.
 *
 * `node test/browser-stack-last-card-full-height.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/bills-period-end-balance-data');

const root = path.join(__dirname, '..');
let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

// The two rules this change removed, served back for the mutant.
const OLD_TRIMS = {
  'stack-cards.css': css => css + '\nhtml.stack-view .stack-block:has(+ .stack-block:empty) .sc-card:last-of-type,html.stack-view .stack-block:last-child .sc-card:last-of-type{padding-bottom:22px}\n',
  'stack.css': css => {
    const now = 'html.stack-view [data-stack-block="credit"].stack-slot .stack-credit { padding-bottom: 56px; }';
    assert.equal(css.split(now).length, 2, 'the Credit foot rule is found exactly once');
    return css.replace(now, 'html.stack-view .stack-credit { padding-bottom: 22px; }\n'
      + 'html.stack-view [data-stack-block="credit"].stack-slot:not(:last-child) .stack-credit { padding-bottom: 56px; }');
  },
};

function world() {
  const d = fx.served();
  d.meta = { ...(d.meta || {}), asOf: fx.AS_OF };
  return d;
}

async function open(browser, width, { mutant = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 1400 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== 'http://stack.test') return route.abort();
    if (u.pathname === '/data.json') return route.fulfill({ json: world() });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
    const name = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
    const file = path.join(root, 'public', name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
    const body = fs.readFileSync(file, 'utf8');
    return route.fulfill({ body: mutant && OLD_TRIMS[name] ? OLD_TRIMS[name](body) : fs.readFileSync(file),
      contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
  });
  await page.goto('http://stack.test/');
  await page.waitForFunction(() => !document.querySelector('[data-boot-notice]') && document.querySelector('.sc-cards')
    && document.querySelector('[data-stack-slot="credit"] .stack-credit'), null, { timeout: 30000 });
  return { page, errors };
}

// One entry per slot of the pile: its id and its closed card's height.
const measure = page => page.$$eval('[data-stack-pile] > [data-stack-slot]', els => els.map(slot => {
  const card = slot.querySelector('details.sc-card, .stack-credit') || slot;
  return { id: slot.getAttribute('data-stack-slot'), height: card.getBoundingClientRect().height,
    open: card.matches('details[open], .is-open') };
}));
// Move a slot to the bottom with the pile's own keyboard reordering (Alt+ArrowDown from its head).
async function moveLast(page, id) {
  const head = page.locator(`[data-stack-slot="${id}"] > details > summary, [data-stack-slot="${id}"] .stack-credit-head`).first();
  const n = (await measure(page)).length;
  await head.focus();
  for (let i = 0; i < n; i++) await page.keyboard.press('Alt+ArrowDown');
  await page.waitForTimeout(100);
}
async function equalHeights(page, label) {
  const m = await measure(page), info = JSON.stringify(m);
  ok(m.length >= 4 && m.some(x => x.id === 'credit') && m.every(x => !x.open), label + ': the closed pile is there, Credit included', info);
  ok(new Set(m.map(x => x.height)).size === 1, label + ': every closed card is the same height, the last included', info);
  return m;
}

(async () => {
  const browser = await chromium.launch();
  try {
    for (const width of [390, 320]) {
      console.log(`1-2. At ${width} wide`);
      const { page, errors } = await open(browser, width);
      await equalHeights(page, width + ' default order');
      for (const id of ['credit', 'billsacct', 'budget']) {
        await moveLast(page, id);
        const m = await equalHeights(page, `${width} ${id} last`);
        ok(m[m.length - 1].id === id, `${width}: ${id} is the last card in the pile`, JSON.stringify(m.map(x => x.id)));
      }
      const end = await page.evaluate(() => {
        const slots = document.querySelectorAll('[data-stack-pile] > [data-stack-slot]');
        const last = slots[slots.length - 1].querySelector('details.sc-card, .stack-credit');
        window.scrollTo(0, document.documentElement.scrollHeight);
        const r = last.getBoundingClientRect();
        return { foot: r.bottom, view: window.innerHeight, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      ok(end.foot <= end.view + 0.5, width + ': scrolled to the end, the last card\'s foot is in view', JSON.stringify(end));
      ok(end.sideways <= 0, width + ': nothing scrolls sideways', JSON.stringify(end));
      ok(errors.length === 0, width + ': no page errors', errors.join(' | '));
      await page.close();
    }
    console.log('3. Mutant: the old last-card trims served back');
    for (const width of [390, 320]) {
      const { page } = await open(browser, width, { mutant: true });
      await moveLast(page, 'credit');
      const m = await measure(page);
      const last = m[m.length - 1], rest = m.slice(0, -1);
      ok(last.id === 'credit' && rest.every(x => x.height > last.height) && new Set(m.map(x => x.height)).size > 1,
        `${width}: with the trims back the last card is shorter, which check 1 rejects`, JSON.stringify(m));
      await moveLast(page, 'budget');
      const b = await measure(page);
      ok(b[b.length - 1].height < b[0].height, `${width}: with the trims back a last Budget card is shorter too`, JSON.stringify(b));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\nPASS last stack card full height (${checks} checks)`);
})().catch(err => { console.error(err); process.exit(1); });
