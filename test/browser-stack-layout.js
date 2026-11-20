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
async function open(browser, width, theme = 'light', { fontDelayMs = 0 } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce', colorScheme: theme });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== 'http://stack.test') return route.abort();
    if (u.pathname === '/data.json') return route.fulfill({ json: fx.served({ mortgageObligation: true }) });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
    const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
    const send = () => route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(file)] || 'application/octet-stream' })
      .catch(() => {});
    // A slow font (a cold phone load): the chips are laid out, then widen when the font arrives.
    if (fontDelayMs && u.pathname.endsWith('.woff2')) return new Promise(r => setTimeout(r, fontDelayMs)).then(send);
    return send();
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
    // The label's own words: its text nodes, not the design's decorative letter tile or swatch (aria-hidden).
    const words = [...lab.childNodes].filter(c => c.nodeType === 3 && c.textContent.trim());
    const l = words.flatMap(ink), a = ink(n), box = li.getBoundingClientRect();
    const measured = l.length > 0 && a.length > 0;
    return { label: words.map(w => w.textContent).join('').trim(), card: li.classList.contains('wf-card'), measured,
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
  // A card's strip is its head (the summary row): the pile lets the next card cover a card's bottom padding, never its head.
  // Credit's is its head button.
  const els = [...document.querySelectorAll('#stack-root [data-stack-card] > summary'), document.querySelector('#stack-root [data-stack-credit-toggle]')]
    .filter(Boolean);
  return els.map(el => {
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    // The strip's four edges, just inside (clear of its rounded corners), and its centre.
    const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    const points = [[cx, r.top + 4], [cx, r.bottom - 4], [r.left + 4, cy], [r.right - 4, cy], [cx, cy]];
    const covered = points.filter(([x, y]) => { const hit = document.elementFromPoint(x, y); return !hit || !el.contains(hit); }).length;
    const page = el.getBoundingClientRect();
    return { name: (el.parentElement && el.parentElement.dataset.stackCard) || 'credit',
      top: page.top + window.scrollY, bottom: page.bottom + window.scrollY, left: r.left, right: r.right,
      height: r.height, covered, viewport: document.documentElement.clientWidth };
  });
});


// The slab's printed surplus, set to an invented estimated value, measured as drawn: its ink blended at its own
// opacity over the slab's fill, as a contrast ratio. Reports whether it carries the soft (estimated) treatment.
const slabInk = (page, amount) => page.evaluate(value => {
  const original = window.__origRecommend || (window.__origRecommend = Forecast.recommend);
  Forecast.recommend = function () {
    const r = original.apply(this, arguments);
    (r.payPeriodViews || []).forEach(v => {
      v.stackSummary = Object.assign(v.stackSummary || {}, { surplus: Object.assign({}, v.stackSummary && v.stackSummary.surplus,
        { amount: value, trust: 'estimated' }) });
    });
    return r;
  };
  App.rerender();
  const rgb = t => (t.match(/[\d.]+/g) || []).map(Number);
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const slab = document.querySelector('#stack-root .wf-slab');
  const n = slab && slab.querySelector('.n:not([data-unpublished])');
  if (!n) return { measured: false };
  const fg = rgb(getComputedStyle(n).color), bg = rgb(getComputedStyle(slab).backgroundColor);
  const a = Number(getComputedStyle(n).opacity) * (fg.length > 3 ? fg[3] : 1);
  const ink = [0, 1, 2].map(k => a * fg[k] + (1 - a) * bg[k]);
  const [hi, lo] = [lum(ink), lum(bg.slice(0, 3))].sort((x, y) => y - x);
  return { measured: true, text: n.textContent, neg: slab.classList.contains('neg'), soft: n.classList.contains('stack-est'),
    opacity: a, ratio: Math.round((hi + 0.05) / (lo + 0.05) * 100) / 100 };
}, amount);

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

    console.log('control: the overlap check catches a pile that covers a head');
    {
      const { page } = await open(browser, 390);
      await page.addStyleTag({ content: 'html.stack-view .stack-bare + .stack-bare { margin-top: -120px; }' });
      await page.waitForTimeout(50);
      const s = await strips(page);
      ok(s.some(x => x.covered > 0), 'with the Credit block overlapping again, the Mortgage strip is reported covered',
        JSON.stringify(s.map(x => [x.name, x.covered])));
      await page.addStyleTag({ content: 'html.stack-view .stack-waterfall .wf-slab .n { font-size: 66px; }' });
      const fit = await slabFit(page, ['−$12,345.67']);
      ok(fit.some(r => r.overflow || r.inkRight > r.inner + 0.5), 'with the old fixed 66px size, the long value is reported past the slab edge');
      await page.close();
    }
    console.log('the surplus slab: an estimated surplus or deficit stays soft and readable (4.5:1 or more)');
    for (const theme of ['light', 'dark']) {
      const { page, errors } = await open(browser, 390, theme);
      const drawn = [await slabInk(page, 1000), await slabInk(page, -250.5)];
      ok(drawn.every(r => r.measured && r.soft && r.opacity < 1 && r.ratio >= 4.5) && drawn[1].neg && !drawn[0].neg,
        `${theme}: an estimated surplus and deficit keep the soft treatment and clear 4.5:1 on the slab`, JSON.stringify(drawn));
      ok(errors.length === 0, 'no page errors', errors.join('; '));
      if (theme === 'light') {
        console.log('control: the contrast check catches the shell\'s plain .58 fade on the slab');
        await page.addStyleTag({ content: 'html.stack-view .stack-waterfall .wf-slab .n.stack-est { opacity: .58; }' });
        const faded = await slabInk(page, -250.5);
        ok(faded.measured && faded.ratio < 4.5, 'with the .58 fade, the deficit is reported under 4.5:1', JSON.stringify(faded));
      }
      await page.close();
    }
    console.log('the timeline: clean edges, and the selected period centred (owner, Dale, 2026-11-20)');
    {
      const place = page => page.evaluate(() => {
        const row = document.querySelector('#stack-root [data-stack-chips]');
        const chip = row.querySelector('[aria-pressed="true"]');
        const r = row.getBoundingClientRect(), c = chip.getBoundingClientRect(), cs = getComputedStyle(row);
        return { key: chip.getAttribute('data-stack-period'), chips: row.children.length,
          inside: c.left >= r.left + 20 && c.right <= r.right - 20, offCentre: Math.round((c.left + c.width / 2) - (r.left + r.width / 2)),
          mask: cs.maskImage || cs.webkitMaskImage || '', snap: cs.scrollSnapType, padStart: parseFloat(cs.paddingLeft) };
      });
      // Older periods arriving after the first draw (late history): the same views, ten earlier pay periods in front.
      const lateHistory = page => page.evaluate(() => {
        const original = Forecast.recommend;
        Forecast.recommend = function () {
          const rec = original.apply(this, arguments);
          const views = rec.payPeriodViews || [], first = views[0];
          const earlier = [];
          for (let i = 10; i >= 1; i--) {
            const start = new Date(first.start + 'T12:00:00Z'); start.setUTCDate(start.getUTCDate() - 14 * i);
            const end = new Date(start); end.setUTCDate(end.getUTCDate() + 13);
            earlier.push(Object.assign({}, first, { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), role: 'closed' }));
          }
          rec.payPeriodViews = earlier.concat(views);
          return rec;
        };
        App.rerender();
      });
      const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      for (const [label, opts] of [['load', {}], ['slow font', { fontDelayMs: 1500 }]]) {
        const { page, errors } = await open(browser, 390, 'light', opts);
        await settle(page);
        const at = await place(page);
        ok(at.inside && Math.abs(at.offCentre) <= 4, `${label}: the selected chip is fully in view and centred at 390`, JSON.stringify(at));
        if (label === 'load') {
          ok(/linear-gradient\(to right, (transparent|rgba\(0, 0, 0, 0\)), (rgb\(0, 0, 0\)|#000) 24px/.test(at.mask) && at.snap === 'x mandatory' && at.padStart >= 24,
            'the strip fades over 24px at each end, snaps chips to whole positions, and pads its ends past the fade', JSON.stringify(at));
          await lateHistory(page); await settle(page);
          const later = await place(page);
          ok(later.chips > at.chips && later.key === at.key && later.inside && Math.abs(later.offCentre) <= 4,
            'older periods arriving later keep the selected chip in view and centred', JSON.stringify(later));
          // The household scrolls the row themselves: a later re-render keeps the same chip where they left it.
          await page.mouse.move(200, (await page.$eval('#stack-root [data-stack-chips]', r => r.getBoundingClientRect().top + 20)));
          await page.mouse.wheel(0, 0);
          await page.$eval('#stack-root [data-stack-chips]', r => { r.dispatchEvent(new Event('pointerdown')); r.scrollLeft = 0; });
          await settle(page);
          const before = await page.evaluate(() => { const row = document.querySelector('#stack-root [data-stack-chips]');
            const c = row.children[2]; return { key: c.getAttribute('data-stack-period'), x: Math.round(c.getBoundingClientRect().left) }; });
          await page.evaluate(() => App.rerender()); await settle(page);
          const after = await page.evaluate(k => { const c = document.querySelector(`#stack-root [data-stack-period="${k}"]`);
            return Math.round(c.getBoundingClientRect().left); }, before.key);
          ok(Math.abs(after - before.x) <= 1, 'after the household scrolls, a re-render leaves the same chip where they left it', JSON.stringify({ before, after }));
          await page.click('#stack-root [data-stack-now]'); await settle(page);
          const now = await place(page);
          ok(now.inside && Math.abs(now.offCentre) <= 4, '"Now" brings the current period back to the centre', JSON.stringify(now));
        }
        ok(errors.length === 0, 'no page errors', errors.join('; '));
        await page.close();
      }
    }

    console.log('the waterfall\'s Mortgage line opens the mortgage sheet (no Mortgage card; owner, 2026-11-20)');
    {
      const { page, errors } = await open(browser, 390);
      const line = '#stack-root [data-block="waterfall"] [data-row="mortgage"] button[data-stack-sheet^="mortgage:"]';
      const key = await page.$eval(line, b => b.getAttribute('data-stack-sheet')).catch(() => null);
      ok(!!key, 'the Mortgage line is a button carrying the mortgage row\'s sheet key', String(key));
      // The fixture publishes a real mortgage obligation (#1465's mortgageObligation), so the line prints an amount, and
      // the sheet it opens must head with that same amount: one published figure, one printed value.
      const lineAmount = await page.$eval('#stack-root [data-block="waterfall"] [data-row="mortgage"] .n', n => n.textContent.trim());
      for (const how of ['tap', 'Enter']) {
        if (how === 'tap') await page.click(line);
        else { await page.focus(line); await page.keyboard.press('Enter'); }
        await page.waitForSelector('.stack-sheet', { timeout: 3000 }).catch(() => {});
        const sheet = await page.evaluate(() => { const el = document.querySelector('.stack-sheet');
          return el ? el.innerText.replace(/\s+/g, ' ').trim().slice(0, 40) : null; });
        ok(!!sheet && /^Mortgage\b/.test(sheet), `a ${how} on the line opens the mortgage sheet`, String(sheet));
        if (how === 'tap') {
          const big = await page.$eval('.stack-sheet .stack-sheet-big', n => n.textContent.trim()).catch(() => null);
          ok(/^\$[\d,]+$/.test(lineAmount) && lineAmount !== '$0' && big === lineAmount,
            'the line and the sheet it opens print the same published mortgage amount (not $0)', JSON.stringify({ lineAmount, big }));
        }
        await page.keyboard.press('Escape'); await page.waitForTimeout(100);
      }
      ok(errors.length === 0, 'no page errors', errors.join('; '));
      await page.close();
    }
    console.log('the side gutter is the design\'s 16px at phone width (Wallet mock), and the current page is unchanged');
    for (const width of [320, 390, 430, 440]) { // the design's column is 440px wide: wider screens centre it
      const { page, errors } = await open(browser, width);
      const edges = await page.evaluate(() => ['[data-stack-block="timeline"]', '.stack-wf-block', '[data-stack-card="bills"]', '[data-stack-credit]']
        .map(sel => { const el = document.querySelector('#stack-root ' + sel); if (!el) return { sel, missing: true };
          const r = el.getBoundingClientRect(); return { sel, left: Math.round(r.left), right: Math.round(innerWidth - r.right) }; }));
      ok(edges.every(e => !e.missing && e.left === 16 && e.right === 16), `${width}: every block sits 16px from each edge`, JSON.stringify(edges));
      ok(errors.length === 0, 'no page errors', errors.join('; '));
      await page.close();
    }
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' });
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.origin !== 'http://stack.test') return route.abort();
        if (u.pathname === '/data.json') return route.fulfill({ json: fx.served() });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
        const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
      });
      await page.goto('http://stack.test/?view=classic');
      await page.waitForSelector('.wrap');
      await page.waitForTimeout(500);
      const pad = await page.evaluate(() => [getComputedStyle(document.querySelector('.wrap')).paddingLeft, document.documentElement.classList.contains('stack-view')]);
      ok(pad[1] === false && pad[0] !== '0px', 'the current page (?view=classic) keeps its own .wrap padding', JSON.stringify(pad));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\nPASS Stack layout on a phone (${checks})`);
})().catch(error => { console.error(error); process.exit(1); });
