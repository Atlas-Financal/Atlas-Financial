'use strict';
// Loading-screen tips (Dale, 2026-11-18; light lane, UI only). While the
// boot notice is loading, a card under the status line shows one short
// how-to-use-Atlas tip at a time:
//   1  the card renders inside the loading notice, aria-hidden, with one
//      tip and one dot per tip, the current dot on; Cancel stays the
//      notice's first child and the status text is unchanged;
//   2  it moves on by itself after ~6s, and on a tap;
//   3  every tip is static copy with no money pattern (no digit, no
//      currency sign), the list is the same on every load, and two loads on
//      the same day start on the same tip (a boot is reproducible);
//   4  under prefers-reduced-motion nothing animates (tip entrance and the
//      background drift), but the tip still changes;
//   5  the crit (cancelled) surface carries no tips and no drift;
//   6  /data.json is requested before the card exists (the card never
//      delays the data load).
// Served from public/ through page.route with /data.json held, so the
// loading state is real; no figures are ever served.
//
//   node test/test-boot-tips.js
//   BOOT_TIPS_SHOTS=1 node test/test-boot-tips.js   (also writes the
//   390px phone screenshots, light and dark, to docs/proof/boot-tips/)
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
// Skip guard (test-suites-playwright-reach.js): the hosted npm test jobs
// install no browser library, so Playwright is loaded only when present.
let hasPlaywright = true;
try { require.resolve('playwright'); } catch { hasPlaywright = false; }
if (!hasPlaywright || process.env.ATLAS_SKIP_BROWSER === '1') {
  console.log('  SKIP  loading-tips browser cases: Playwright Chromium is not available here');
  process.exit(0);
}
const { chromium } = require('playwright');

const MONEY = /[\d$€£¢]/;
let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

async function open(browser, contextOpts = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...contextOpts });
  const page = await context.newPage();
  const order = [];
  await page.route('**/*', async r => {
    const url = new URL(r.request().url());
    if (url.origin !== 'http://boot.test') return r.abort();
    if (url.pathname === '/data.json') { order.push('data'); return; } // held: never answered
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return r.fulfill({ json: null });
    if (url.pathname === '/talk/capability') return r.fulfill({ json: { available: false } });
    if (url.pathname.startsWith('/talk/')) return r.fulfill({ status: 404, body: '' });
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(root, 'public', rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return r.fulfill({ status: 404, body: '' });
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript'
      : file.endsWith('.png') ? 'image/png' : file.endsWith('.woff2') ? 'font/woff2' : 'text/html';
    return r.fulfill({ body: fs.readFileSync(file), contentType: type });
  });
  await page.exposeFunction('__tipsSeen', () => order.push('tips'));
  await page.addInitScript(() => {
    new MutationObserver((_, obs) => {
      if (document.querySelector('[data-boot-tips]')) { window.__tipsSeen(); obs.disconnect(); }
    }).observe(document, { childList: true, subtree: true });
  });
  return { context, page, order };
}

const state = page => page.evaluate(() => {
  const n = document.querySelector('[data-boot-notice]');
  const card = document.querySelector('[data-boot-tips]');
  const tip = card && card.querySelector('[data-boot-tip]');
  return {
    noticeClass: n && n.className,
    firstChild: n && n.children[0] && n.children[0].textContent,
    noticeLead: n && n.firstChild && n.firstChild.nodeType === 3 ? n.firstChild.textContent : null,
    card: !!card,
    hidden: card && card.getAttribute('aria-hidden'),
    insideNotice: !!(n && card && n.contains(card)),
    text: tip && tip.textContent,
    index: card && Number(card.getAttribute('data-boot-tip-index')),
    dots: card ? card.querySelectorAll('.boot-tip-dots i').length : 0,
    on: card ? [...card.querySelectorAll('.boot-tip-dots i')].findIndex(d => d.classList.contains('is-on')) : -1,
    tipAnim: tip ? getComputedStyle(tip).animationName : null,
    driftAnim: n ? getComputedStyle(n, '::before').animationName : null,
    driftContent: n ? getComputedStyle(n, '::before').content : null,
  };
});
const waitLoading = page => page.waitForSelector('[data-boot-notice].is-loading [data-boot-tips]', { timeout: 15000 });

(async () => {
  const browser = await chromium.launch();
  try {
    console.log('1-3, 6: renders, rotates on time and on tap, static copy');
    {
      const { context, page, order } = await open(browser);
      await context.clock.install();
      await page.goto('http://boot.test/', { waitUntil: 'commit' });
      await waitLoading(page);
      const s = await state(page);
      ok(s.card && s.insideNotice && s.hidden === 'true', 'the tips card is inside the loading notice and aria-hidden', JSON.stringify(s));
      ok(s.firstChild === 'Cancel', 'Cancel is still the notice\'s first child', s.firstChild);
      ok(s.noticeLead === 'Loading current data... This can take a couple of minutes. ', 'the status line is unchanged', JSON.stringify(s.noticeLead));
      ok(typeof s.text === 'string' && s.text.length > 10 && s.dots >= 5 && s.on === s.index,
        'one tip shown, one dot per tip, the current dot on', `${s.dots} dots, on ${s.on}, index ${s.index}`);
      ok(s.tipAnim === 'boot-tip-in' && s.driftAnim === 'boot-drift', 'the tip entrance and the background drift animate', `${s.tipAnim} / ${s.driftAnim}`);
      ok(order.indexOf('data') >= 0 && order.indexOf('data') < order.indexOf('tips'),
        '/data.json is requested before the tips card exists', order.join(' > '));

      await context.clock.runFor(5500);
      ok((await state(page)).index === s.index, 'the tip holds before ~6s');
      await context.clock.runFor(700);
      const t = await state(page);
      ok(t.index === (s.index + 1) % s.dots && t.text !== s.text && t.on === t.index, 'it moves to the next tip after ~6s', `${s.index} -> ${t.index}`);

      await page.click('[data-boot-tips]');
      const u = await state(page);
      ok(u.index === (t.index + 1) % s.dots, 'a tap skips to the next tip', `${t.index} -> ${u.index}`);
      await context.clock.runFor(5500);
      ok((await state(page)).index === u.index, 'a tap restarts the ~6s wait');

      const all = new Set();
      for (let k = 0; k < s.dots; k++) { all.add((await state(page)).text); await page.click('[data-boot-tips]'); }
      ok(all.size === s.dots, 'a full lap shows every tip once', `${all.size} of ${s.dots}`);
      const money = [...all].filter(x => MONEY.test(x));
      ok(money.length === 0, 'no tip carries a digit or currency sign (no figures)', money.join(' | '));
      const again = await open(browser);
      await again.page.goto('http://boot.test/', { waitUntil: 'commit' });
      await waitLoading(again.page);
      const s2 = await state(again.page);
      ok(s2.dots === s.dots && all.has(s2.text), 'the tip list is the same fixed copy on every load', s2.text);
      ok(s2.index === s.index, 'two loads on the same day start on the same tip', `${s.index} / ${s2.index}`);
      await again.context.close();

      console.log('5: the cancelled (crit) surface');
      await page.click('[data-boot-notice] button');
      await page.waitForSelector('[data-boot-notice].crit', { timeout: 10000 });
      const c = await state(page);
      ok(!c.card, 'no tips card on the crit surface');
      ok(c.driftContent === 'none' || c.driftAnim === 'none', 'no background drift on the crit surface', `${c.driftContent} / ${c.driftAnim}`);
      await context.clock.runFor(13000);
      ok(!(await state(page)).card, 'the stopped timer never brings the card back');
      await context.close();
    }

    console.log('4: prefers-reduced-motion');
    {
      const { context, page } = await open(browser, { reducedMotion: 'reduce' });
      await context.clock.install();
      await page.goto('http://boot.test/', { waitUntil: 'commit' });
      await waitLoading(page);
      const s = await state(page);
      ok(s.tipAnim === 'none' && s.driftAnim === 'none', 'nothing animates under reduced motion', `${s.tipAnim} / ${s.driftAnim}`);
      await context.clock.runFor(6200);
      const t = await state(page);
      ok(t.index !== s.index && t.text !== s.text, 'the tip text still changes', `${s.index} -> ${t.index}`);
      await context.close();
    }

    if (process.env.BOOT_TIPS_SHOTS === '1') {
      const outDir = path.join(root, 'docs', 'proof', 'boot-tips');
      fs.mkdirSync(outDir, { recursive: true });
      for (const scheme of ['light', 'dark']) {
        const { context, page } = await open(browser, { deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: 'reduce' });
        await context.clock.setFixedTime(new Date('2026-11-18T12:00:00'));
        await page.goto('http://boot.test/', { waitUntil: 'commit' });
        await waitLoading(page);
        await page.screenshot({ path: path.join(outDir, `loading-tips-${scheme}-390.png`) });
        await context.close();
      }
      console.log('  wrote docs/proof/boot-tips/loading-tips-{light,dark}-390.png');
    }
  } finally {
    await browser.close();
  }
  console.log(failures ? `\n${failures} failure(s)` : '\nall cases pass');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
