'use strict';
/* The Stack page's layout on a phone, in a real browser: real App.boot, the real public/ files, invented data only
 * (test/fixtures/budget-surface-data.js served for /data.json by route interception; no server, no household data).
 *
 *   1. The surplus fits its slab: at 320 and 390 wide (and 1440), the printed surplus and a long value such as
 *      −$12,345.67 end inside the slab's padding, with no overflow or clipping.
 *   3. The waterfall rows at 320 wide: each label on one line, at least 8px from its amount (a long invented amount in
 *      every row), nothing past the row's edge, no horizontal page scroll.
 *   2. Every card's strip is fully visible and tappable: each card's summary (Bills, Budget, Mortgage) and the Credit
 *      head lie wholly inside the page, no later block covers them (the element at each strip's corners and centre is
 *      the strip itself), and they do not overlap one another. Closed and with Credit open.
 *
 * Local (hosted CI has no browser); the static rules behind both are pinned in test-stack-shell (section 7).
 * `node test/browser-stack-layout.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');

const root = path.join(__dirname, '..');
let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };

const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2' };
async function open(browser, width) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== 'http://stack.test') return route.abort();
    if (u.pathname === '/data.json') return route.fulfill({ json: fx.served() });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
    const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
  });
  await page.goto('http://stack.test/?view=stack');
  await page.waitForSelector('#stack-root .wf-slab .n');
  await page.waitForSelector('#stack-root [data-stack-card]');
  await page.evaluate(() => document.fonts.ready);
  return { page, errors };
}

// Where the printed text ends against the slab's inner edge (its right padding), for the current text and for others.
const slabFit = (page, texts) => page.evaluate(values => {
  const n = document.querySelector('#stack-root .wf-slab .n');
  const slab = n.closest('.wf-slab');
  const pad = parseFloat(getComputedStyle(slab).paddingRight);
  const original = n.textContent;
  const rows = [original, ...values].map(text => {
    n.textContent = text;
    const range = document.createRange();
    range.selectNodeContents(n);
    const ink = range.getBoundingClientRect();
    const box = slab.getBoundingClientRect();
    return { text, inkRight: ink.right, inner: box.right - pad, overflow: n.scrollWidth > n.clientWidth + 1 || slab.scrollWidth > slab.clientWidth + 1 };
  });
  n.textContent = original;
  return rows;
}, texts);

// Each strip: its rectangle, and whether the strip itself is what sits at its corners and centre (nothing covers it).
const strips = page => page.evaluate(() => {
  // A card's strip is the closed card itself (its summary row and padding); Credit's is its head.
  const els = [...document.querySelectorAll('#stack-root [data-stack-card]'), document.querySelector('#stack-root [data-stack-credit-toggle]')]
    .filter(Boolean);
  return els.map(el => {
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    // The strip's four edges, just inside (clear of its rounded corners), and its centre.
    const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    const points = [[cx, r.top + 4], [cx, r.bottom - 4], [r.left + 4, cy], [r.right - 4, cy], [cx, cy]];
    const covered = points.filter(([x, y]) => { const hit = document.elementFromPoint(x, y); return !hit || !el.contains(hit); }).length;
    const page = el.getBoundingClientRect();
    return { name: el.dataset.stackCard || 'credit',
      top: page.top + window.scrollY, bottom: page.bottom + window.scrollY, left: r.left, right: r.right,
      height: r.height, covered, viewport: document.documentElement.clientWidth };
  });
});

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    for (const width of [320, 390, 1440]) {
      console.log(`${width} wide`);
      const { page, errors } = await open(browser, width);

      const fit = await slabFit(page, ['−$12,345.67', '+$9,999.99']);
      const bad = fit.filter(r => r.overflow || r.inkRight > r.inner + 0.5);
      ok(fit.length === 3 && bad.length === 0, `the surplus and long values end inside the slab (${fit.map(r => r.text).join(', ')})`,
        JSON.stringify(bad));

      for (const state of ['closed', 'Credit open']) {
        if (state === 'Credit open') {
          await page.click('[data-stack-credit-toggle]');
          await page.waitForTimeout(100);
        }
        const s = await strips(page);
        const names = s.map(x => x.name).join(',');
        ok(names === 'bills,budget,mortgage,credit', `${state}: the Bills, Budget, Mortgage and Credit strips are found`, names);
        const hidden = s.filter(x => x.covered > 0 || x.height < 40 || x.left < 0 || x.right > x.viewport);
        ok(hidden.length === 0, `${state}: every strip is wholly visible and is what a tap on it reaches`, JSON.stringify(hidden));
        const overlaps = s.slice(1).filter((x, i) => x.top < s[i].bottom - 0.5);
        ok(overlaps.length === 0, `${state}: no strip overlaps the one above it`, JSON.stringify(overlaps.map(x => x.name)));
      }
      ok(errors.length === 0, 'no page errors', errors.join('; '));
      await page.close();
    }

    console.log('the waterfall rows at 320 wide: one line each, a gap before every amount, even for a long one');
    {
      const { page, errors } = await open(browser, 320);
      await page.click('[data-wf-toggle="credit"]').catch(() => {});
      await page.waitForTimeout(100);
      const rows = await page.evaluate(() => {
        const ink = el => { const r = document.createRange(); r.selectNodeContents(el); return [...r.getClientRects()]; };
        const wf = document.querySelector('#stack-root [data-block="waterfall"]');
        // A long invented amount in every published row, to prove the fit is not luck of today's figures.
        for (const n of wf.querySelectorAll('.wf-line .n:not([data-unpublished]), .wf-card .n:not([data-unpublished])')) n.textContent = '$12,345.67';
        return [...wf.querySelectorAll('.wf-line, .wf-card')].map(li => {
          const lab = li.querySelector('.lab, b'), n = li.querySelector('.n:not([data-unpublished])');
          if (!lab || !n) return null;
          const l = ink(lab), a = ink(n), box = li.getBoundingClientRect();
          return { label: lab.textContent.trim(), lines: new Set(l.map(x => Math.round(x.top))).size,
            gap: Math.min(...a.map(x => x.left)) - Math.max(...l.map(x => x.right)), over: Math.max(...a.map(x => x.right)) - box.right };
        }).filter(Boolean);
      });
      const bad = rows.filter(r => r.lines !== 1 || r.gap < 8 || r.over > 0.5);
      ok(rows.length >= 8 && bad.length === 0, `every waterfall label is one line, 8px or more from its amount, nothing past the edge (${rows.length} rows)`,
        JSON.stringify(bad));
      ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'no horizontal page scroll at 320');
      ok(errors.length === 0, 'no page errors', errors.join('; '));
      await page.close();
    }

    console.log('control: the overlap check catches the old pile rule');
    {
      const { page } = await open(browser, 390);
      await page.addStyleTag({ content: 'html.stack-view .stack-bare + .stack-bare { margin-top: -38px; }' });
      await page.waitForTimeout(50);
      const s = await strips(page);
      ok(s.some(x => x.covered > 0), 'with the Credit block overlapping again, the Mortgage strip is reported covered',
        JSON.stringify(s.map(x => [x.name, x.covered])));
      await page.addStyleTag({ content: 'html.stack-view .stack-waterfall .wf-slab .n { font-size: 66px; }' });
      const fit = await slabFit(page, ['−$12,345.67']);
      ok(fit.some(r => r.overflow || r.inkRight > r.inner + 0.5), 'with the old fixed 66px size, the long value is reported past the slab edge');
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\nPASS Stack layout on a phone (${checks})`);
})().catch(error => { console.error(error); process.exit(1); });
