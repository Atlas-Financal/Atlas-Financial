'use strict';
// Browser twin of test/test-page-renderer-escaping.js (external audit C2).
// Opens Bills, Subscriptions, Credit, Records and Deep Dive in Chromium with
// the invented hostile household (test/fixtures/hostile-page-text.js), hovers
// every chart mark, and proves in the real DOM that:
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
  { path: '/bills.html', idAttr: 'data-bill-id' },
  { path: '/subscriptions.html', idAttr: 'data-subscription-id' },
  { path: '/credit.html', idAttr: 'data-credit-id' },
  { path: '/records.html' },
  { path: '/deepdive.html' },
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
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) {
          return intercepted.fulfill({ json: null });
        }
        const file = path.join(root, 'public', url.pathname.slice(1));
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return intercepted.fulfill({ status: 404, body: '' });
        const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript'
          : file.endsWith('.woff2') ? 'font/woff2' : file.endsWith('.png') ? 'image/png' : 'text/html';
        return intercepted.fulfill({ body: fs.readFileSync(file), contentType: type });
      });
      await page.goto('http://atlas.test' + route.path);
      await page.waitForFunction(label => (document.body.innerText || '').includes(label), H.LABEL, { timeout: 20000 })
        .catch(() => errors.push(`${route.path}: the hostile label never appeared as text`));
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
          handlers,
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
