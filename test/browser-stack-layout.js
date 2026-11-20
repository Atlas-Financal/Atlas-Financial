'use strict';
/* The Stack page's layout on a phone, in a real browser: real App.boot, the real public/ files, invented data only
 * (test/fixtures/budget-surface-data.js served for /data.json by route interception; no server, no household data).
 *
 *   1. The surplus fits its slab: at 320 and 390 wide (and 1440), the printed surplus and a long value such as
 *      −$12,345.67 end inside the slab's padding, with no overflow or clipping.
 *   2. Every card's strip is fully visible and tappable: each card's summary (Bills, Budget, Mortgage) and the Credit
 *      head lie wholly inside the page, no later block covers them (the element at each strip's corners and centre is
 *      the strip itself), and they do not overlap one another. Closed and with Credit open.
 *   3. The waterfall rows at 320 wide: each label on one line, at least 8px from its amount (a long invented amount in
 *      every row), nothing past the row's edge, no horizontal page scroll.
 *   4. Controls: each check fails on the defect it names, and no check passes without measuring what it names (a
 *      missing toggle throws; a row with no measurable text is reported, never skipped).
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

// Opens a disclosure and proves it opened: a missing toggle, or one that does not open, throws (never a silent pass).
async function openToggle(page, toggle, opened) {
  if (!(await page.$(toggle))) throw new Error(`toggle not found: ${toggle}`);
  await page.click(toggle);
  await page.waitForTimeout(100);
  if (!(await page.evaluate(sel => !!document.querySelector(sel), opened))) throw new Error(`did not open: ${opened}`);
}
const openCreditCard = page => openToggle(page, '[data-stack-credit-toggle]', '[data-stack-credit-toggle][aria-expanded="true"]');
const openWaterfallCredit = page => openToggle(page, '[data-wf-toggle="credit"]', '[data-wf-toggle="credit"][aria-expanded="true"]');

// Each waterfall row (the main lines and the open Credit row's cards), with a long invented amount written into every
// published figure. A row is reported 'measured' only when its label and its amount both drew text, so a row that
// cannot be measured fails instead of vanishing from the check.
const measureWaterfall = page => page.evaluate(() => {
  const ink = el => { const r = document.createRange(); r.selectNodeContents(el); return [...r.getClientRects()].filter(x => x.width > 0); };
  const wf = document.querySelector('#stack-root [data-block="waterfall"]');
  for (const n of wf.querySelectorAll('.wf-line .n:not([data-unpublished]), .wf-card .n:not([data-unpublished])')) n.textContent = '$12,345.67';
  return [...wf.querySelectorAll('.wf-line, .wf-card')].map(li => {
    const lab = li.querySelector('.lab, b'), n = li.querySelector('.n:not([data-unpublished])');
    if (!lab || !n) return null; // a row with no published amount has nothing to fit
    const l = ink(lab), a = ink(n), box = li.getBoundingClientRect();
    const measured = l.length > 0 && a.length > 0;
    return { label: lab.textContent.trim(), card: li.classList.contains('wf-card'), measured,
      lines: measured ? new Set(l.map(x => Math.round(x.top))).size : 0,
      gap: measured ? Math.min(...a.map(x => x.left)) - Math.max(...l.map(x => x.right)) : null,
      over: measured ? Math.max(...a.map(x => x.right)) - box.right : null };
  }).filter(Boolean);
});

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
    // measured: the text drew something (an empty or hidden amount must not pass as "fits").
    return { text, measured: ink.width > 0 && ink.height > 0, inkRight: ink.right, inner: box.right - pad,
      overflow: n.scrollWidth > n.clientWidth + 1 || slab.scrollWidth > slab.clientWidth + 1 };
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
      const bad = fit.filter(r => !r.measured || r.overflow || r.inkRight > r.inner + 0.5);
      ok(fit.length === 3 && bad.length === 0, `the surplus and long values end inside the slab (${fit.map(r => r.text).join(', ')})`,
        JSON.stringify(bad));

      for (const state of ['closed', 'Credit open']) {
        if (state === 'Credit open') await openCreditCard(page);
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
      await openWaterfallCredit(page);
      const rows = await measureWaterfall(page);
      const bad = rows.filter(r => !r.measured || r.lines !== 1 || r.gap < 8 || r.over > 0.5);
      const cards = rows.filter(r => r.card).length;
      ok(rows.length >= 9 && cards >= 1 && bad.length === 0,
        `every waterfall label is one line, 8px or more from its amount, nothing past the edge (${rows.length} rows, ${cards} card)`,
        JSON.stringify(bad));
      ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'no horizontal page scroll at 320');
      ok(errors.length === 0, 'no page errors', errors.join('; '));
      await page.close();
    }

    console.log('control: no check passes without measuring what it names');
    {
      const { page } = await open(browser, 320);
      await page.evaluate(() => document.querySelector('[data-wf-toggle="credit"]').remove());
      let threw = null;
      try { await openWaterfallCredit(page); } catch (e) { threw = e.message; }
      ok(threw && /toggle not found/.test(threw), 'a missing waterfall Credit toggle throws instead of passing silently', threw || 'no throw');
      // A toggle that no longer opens: its clicks are swallowed before the card's own handler sees them.
      await page.evaluate(() => document.addEventListener('click', e => {
        if (e.target.closest && e.target.closest('[data-stack-credit-toggle]')) { e.stopPropagation(); e.preventDefault(); }
      }, true));
      threw = null;
      try { await openCreditCard(page); } catch (e) { threw = e.message; }
      ok(threw && /did not open/.test(threw), 'a Credit toggle that does not open throws', threw || 'no throw');
      await page.close();
      const p2 = (await open(browser, 320)).page;
      await openWaterfallCredit(p2);
      await p2.addStyleTag({ content: 'html.stack-view .stack-waterfall .wf-line .lab { visibility: hidden; display: none; }' });
      const rows = await measureWaterfall(p2);
      ok(rows.some(r => !r.measured), 'a row whose label draws nothing is reported unmeasured, never skipped', JSON.stringify(rows.map(r => r.measured)));
      await p2.evaluate(() => { document.querySelector('#stack-root .wf-slab .n').style.display = 'none'; });
      const fit = await slabFit(p2, []);
      ok(fit.some(r => !r.measured), 'a slab amount that draws nothing is reported unmeasured');
      await p2.close();
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
