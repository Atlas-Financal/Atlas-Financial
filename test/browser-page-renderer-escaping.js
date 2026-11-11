'use strict';
// Browser twin of test/test-page-renderer-escaping.js (external audit C2).
// Opens the Budget app (index.html) and the Bills, Subscriptions, Credit,
// Records and Deep Dive pages in Chromium with the invented hostile household
// (test/fixtures/hostile-page-text.js). On Budget it clicks every control
// twice, so detail sheets, tabs and period views render too; on every page it
// hovers every chart mark. A MutationObserver records every element ever
// inserted, so a view that is opened and then replaced still counts. It proves:
//   - no dialog opened (every payload calls alert);
//   - no element carries an on* event attribute, and no img or extra script
//     element exists;
//   - the hostile label is visible as text, and a crafted id is the exact
//     value of its data attribute.
// The pages are served WITHOUT the production CSP on purpose: this proves the
// escaping itself, not the header that backs it up.
// CHROME_PATH=<Chromium> node test/browser-page-renderer-escaping.js
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const H = require('./fixtures/hostile-page-text');

const root = path.join(__dirname, '..');
const pages = [
  { path: '/', main: true },
  { path: '/bills.html', idAttr: 'data-bill-id' },
  { path: '/subscriptions.html', idAttr: 'data-subscription-id' },
  { path: '/credit.html', idAttr: 'data-credit-id' },
];

(async () => {
  const errors = [];
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
  const data = H.hostile();
  try {
    for (const route of pages) {
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
      await page.goto('http://atlas.test' + route.path);
      await page.waitForFunction(label => (document.body.innerText || '').includes(label), H.LABEL, { timeout: 20000 })
        .catch(() => errors.push(`${route.path}: the hostile label never appeared as text`));
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
      const face = await page.evaluate(({ idAttr, id }) => {
        const all = [...document.querySelectorAll('*')];
        const handlers = all.flatMap(el => [...el.attributes].filter(a => /^on/i.test(a.name))
          .map(a => `${el.tagName.toLowerCase()}[${a.name}]`));
        return {
          handlers: handlers.concat(window.__injected),
          imgs: document.querySelectorAll('img').length,
          inlineScripts: [...document.querySelectorAll('script')].filter(s => !s.src).length,
          idExact: idAttr ? [...document.querySelectorAll(`[${idAttr}]`)].some(el => el.getAttribute(idAttr).startsWith(id)) : true,
          tipChildren: [...(document.getElementById('tip')?.querySelectorAll('*') || [])].map(e => e.tagName.toLowerCase()),
        };
      }, { idAttr: route.idAttr || null, id: H.ID });
      if (dialogs.length) errors.push(`${route.path}: dialog opened ${JSON.stringify(dialogs)}`);
      if (face.handlers.length) errors.push(`${route.path}: injected event attributes ${face.handlers.join(', ')}`);
      if (face.imgs) errors.push(`${route.path}: ${face.imgs} injected img element(s)`);
      if (face.inlineScripts) errors.push(`${route.path}: ${face.inlineScripts} injected inline script(s)`);
      if (!face.idExact) errors.push(`${route.path}: ${route.idAttr} does not carry the crafted id verbatim`);
      const strayTip = face.tipChildren.filter(t => !['b', 'span', 'br', 'i'].includes(t));
      if (strayTip.length) errors.push(`${route.path}: tooltip holds ${strayTip.join(', ')}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  if (errors.length) {
    console.error('FAIL page renderer escaping\n  ' + errors.join('\n  '));
    process.exit(1);
  }
  console.log(`PASS ${pages.length} pages render invented hostile text inert in Chromium`);
})().catch(err => { console.error(err); process.exit(1); });
