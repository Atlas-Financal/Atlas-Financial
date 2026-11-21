'use strict';
// Browser twin of test/test-page-renderer-escaping.js (external audit C2).
// Opens the Budget app (index.html) in Chromium with the invented hostile
// household (test/fixtures/hostile-page-text.js). It clicks every control
// twice, so detail sheets, tabs and period views render too, and hovers every
// chart mark. A MutationObserver records every element ever
// inserted, so a view that is opened and then replaced still counts. It proves:
//   - no dialog opened (every payload calls alert);
//   - no element carries an on* event attribute, and no img or extra script
//     element exists;
//   - the hostile label is visible as text.
// The pages are served WITHOUT the production CSP on purpose: this proves the
// escaping itself, not the header that backs it up.
// CHROME_PATH=<Chromium> node test/browser-page-renderer-escaping.js
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const H = require('./fixtures/hostile-page-text');

const root = path.join(__dirname, '..');
// The previous page by its explicit route, and the Stack page (the default Budget page) by the default route, with its own
// hostile household and every assertion scoped to #stack-root (the previous page renders hidden under it, so a page-wide check
// could be satisfied by that page alone).
const pages = [
  { path: '/', main: true, search: '?view=classic', name: 'classic page' },
  { path: '/', main: false, stack: true, search: '', name: 'Stack page' },
];

(async () => {
  const errors = [];
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
  try {
    for (const route of pages) {
      const data = route.stack ? H.hostileStack() : H.hostile();
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const dialogs = [];
      page.on('dialog', d => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
      await page.route('**/*', intercepted => {
        const url = new URL(intercepted.request().url());
        if (url.origin !== 'http://atlas.test') return intercepted.abort();
        if (url.pathname === '/data.json') return intercepted.fulfill({ json: data });
        if (url.pathname === '/talk/capability') return intercepted.fulfill({ json: { available: false } });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) {
          return intercepted.fulfill({ json: null });
        }
        const file = path.join(root, 'public', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return intercepted.fulfill({ status: 404, body: '' });
        const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript'
          : file.endsWith('.woff2') ? 'font/woff2' : file.endsWith('.png') ? 'image/png' : 'text/html';
        return intercepted.fulfill({ body: fs.readFileSync(file), contentType: type });
      });
      await page.addInitScript(() => {
        window.__injected = [];
        const note = el => {
          if (!el || el.nodeType !== 1) return;
          // Scoped runs (the Stack page) count only what lands inside #stack-root, its sheet overlay included.
          if (window.__scope && !(el.closest && el.closest(window.__scope))) return;
          for (const node of [el, ...el.querySelectorAll('*')]) {
            const tag = node.tagName.toLowerCase();
            for (const a of node.attributes) if (/^on/i.test(a.name)) window.__injected.push(`${tag}[${a.name}]`);
            if (tag === 'img') window.__injected.push('img');
            if (tag === 'script' && !node.src && document.readyState !== 'loading') window.__injected.push('inline script');
          }
        };
        new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(note)))
          .observe(document, { childList: true, subtree: true });
      });
      if (route.stack) await page.addInitScript(() => { window.__scope = '#stack-root'; });
      await page.goto('http://atlas.test' + route.path + route.search);
      // The hostile label is visible as text (textContent: a closed <details> keeps its content out of innerText).
      await page.waitForFunction(({ label, scope }) => ((scope ? document.querySelector(scope) : document.body) || {}).textContent
        && (scope ? document.querySelector(scope) : document.body).textContent.includes(label), { label: H.LABEL, scope: route.stack ? '#stack-root' : null }, { timeout: 20000 })
        .catch(() => errors.push(`${route.name}: the hostile label never appeared as text`));
      if (route.stack) {
        // Open everything the Stack page offers, twice: Credit and its rows, every sheet row (a bill, a budget category, a
        // card, the mortgage), each period chip. A sheet is closed with Escape before the next row.
        for (let round = 0; round < 2; round++) {
          const n = await page.evaluate(() => {
            const controls = [...document.querySelectorAll('#stack-root [data-stack-credit-toggle], #stack-root [data-wf-toggle], #stack-root summary, #stack-root [data-stack-sheet], #stack-root [data-stack-period]')];
            controls.forEach((el, i) => el.setAttribute('data-escape-probe', String(i)));
            return controls.length;
          });
          if (round === 0 && n < 10) errors.push(`${route.name}: only ${n} controls to open`);
          for (let i = 0; i < Math.min(n, 400); i++) {
            await page.click(`[data-escape-probe="${i}"]`, { timeout: 300, force: true }).catch(() => {});
            await page.keyboard.press('Escape').catch(() => {});
          }
        }
        const sheets = await page.evaluate(() => document.querySelectorAll('#stack-root [data-stack-sheet]').length);
        if (sheets < 5) errors.push(`${route.name}: only ${sheets} sheet rows on the Stack page`);
      }
      if (route.main) {
        for (let round = 0; round < 2; round++) {
          const n = await page.evaluate(() => {
            const controls = [...document.querySelectorAll('button, summary, [role="tab"], [data-budget-bill-open], [tabindex="0"]')];
            controls.forEach((el, i) => el.setAttribute('data-escape-probe', String(i)));
            return controls.length;
          });
          if (round === 0 && n < 20) errors.push(`${route.path}: only ${n} controls to open`);
          for (let i = 0; i < Math.min(n, 400); i++) {
            await page.click(`[data-escape-probe="${i}"]`, { timeout: 300, force: true }).catch(() => {});
          }
        }
      }
      // Hover every chart mark so the shared tooltip renders hostile labels.
      for (const mark of await page.$$('svg rect, svg circle')) {
        await mark.dispatchEvent('mousemove', { clientX: 10, clientY: 10 });
      }
      await page.waitForTimeout(50);
      const face = await page.evaluate(() => {
        const scope = window.__scope ? document.querySelector(window.__scope) : null;
        const all = [...(scope ? [scope, ...scope.querySelectorAll('*')] : document.querySelectorAll('*'))];
        const handlers = all.flatMap(el => [...el.attributes].filter(a => /^on/i.test(a.name))
          .map(a => `${el.tagName.toLowerCase()}[${a.name}]`));
        return {
          handlers: handlers.concat(window.__injected),
          imgs: (scope || document).querySelectorAll('img').length,
          inlineScripts: [...(scope || document).querySelectorAll('script')].filter(s => !s.src).length,
          tipChildren: [...(document.getElementById('tip')?.querySelectorAll('*') || [])].map(e => e.tagName.toLowerCase()),
        };
      });
      if (dialogs.length) errors.push(`${route.name}: dialog opened ${JSON.stringify(dialogs)}`);
      if (face.handlers.length) errors.push(`${route.name}: injected event attributes ${face.handlers.join(', ')}`);
      if (face.imgs) errors.push(`${route.name}: ${face.imgs} injected img element(s)`);
      if (face.inlineScripts) errors.push(`${route.name}: ${face.inlineScripts} injected inline script(s)`);
      const strayTip = face.tipChildren.filter(t => !['b', 'span', 'br', 'i'].includes(t));
      if (strayTip.length) errors.push(`${route.name}: tooltip holds ${strayTip.join(', ')}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  if (errors.length) {
    console.error('FAIL page renderer escaping\n  ' + errors.join('\n  '));
    process.exit(1);
  }
  console.log('PASS Budget page renders invented hostile text inert in Chromium');
})().catch(err => { console.error(err); process.exit(1); });
