'use strict';
// Every existing household and diagnostic route still renders when opened
// by URL. Budget no longer has a page nav. The other pages keep theirs.
// CHROME_PATH=<Chromium> node test/browser-routes-render.js
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');

const root = path.join(__dirname, '..');
const routes = [
  { path: '/', kind: 'budget' },
  { path: '/index.html', kind: 'budget' },
  { path: '/planning.html', kind: 'household', shell: 'planning' },
  { path: '/plan-spend.html', kind: 'household', shell: 'plan-spend' },
  { path: '/modellers.html', kind: 'diagnostic' },
];

(async () => {
  const errors = [];
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    headless: true,
  });
  const data = fx.served();
  try {
    for (const route of routes) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const pageErrors = [];
      page.on('pageerror', err => pageErrors.push(err.message));
      await page.route('**/*', intercepted => {
        const url = new URL(intercepted.request().url());
        if (url.origin !== 'http://budget.test') return intercepted.abort();
        if (url.pathname === '/data.json') return intercepted.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) {
          return intercepted.fulfill({ json: null });
        }
        if (url.pathname === '/talk/capability') return intercepted.fulfill({ json: { available: false } });
        if (url.pathname === '/talk/context') return intercepted.fulfill({ status: 404, body: '' });
        const file = path.join(root, 'public', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return intercepted.fulfill({ status: 404, body: '' });
        const type = file.endsWith('.css') ? 'text/css'
          : file.endsWith('.js') ? 'application/javascript'
          : file.endsWith('.woff2') ? 'font/woff2'
          : file.endsWith('.png') ? 'image/png'
          : 'text/html';
        return intercepted.fulfill({ body: fs.readFileSync(file), contentType: type });
      });
      await page.goto('http://budget.test' + route.path);
      await page.waitForFunction(() => {
        const budget = document.querySelector('#operating-surface');
        const heading = document.querySelector('h1, [data-page-shell]');
        const budgetText = budget ? (budget.innerText || '').trim() : '';
        const headingText = heading ? (heading.innerText || '').trim() : '';
        return budgetText.length > 20 || headingText.length > 0;
      }, { timeout: 20000 });
      const face = await page.evaluate(kind => {
        const main = document.querySelector('#operating-surface, [data-page-shell], main, h1');
        return {
          text: main ? (main.innerText || '').trim().length : 0,
          nav: document.querySelectorAll('.sitenav, .sitenav-household').length,
          shell: document.querySelector('[data-page-shell]')?.getAttribute('data-page-shell') || '',
          budget: !!document.querySelector('[data-budget-surface], #operating-surface'),
        };
      }, route.kind);
      if (pageErrors.length) errors.push(`${route.path} threw ${pageErrors.join(' | ')}`);
      if (face.text < 1) errors.push(`${route.path} rendered no main content`);
      if (route.kind === 'budget' && (face.nav !== 0 || !face.budget)) {
        errors.push(`${route.path} budget shell ${JSON.stringify(face)}`);
      }
      if (route.kind === 'household' && (face.nav < 1 || face.shell !== route.shell)) {
        errors.push(`${route.path} household shell ${JSON.stringify(face)}`);
      }
      if (route.kind === 'diagnostic' && face.nav < 1) {
        errors.push(`${route.path} diagnostic nav missing ${JSON.stringify(face)}`);
      }
      console.log(`${route.path} text ${face.text} nav ${face.nav}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log(`PASS route render: ${routes.length} routes`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
