'use strict';
// Browser twin of test/test-forecast-text-escaping.js (stored XSS).
//
// Opens the real Budget page in Chromium with the invented hostile household
// (fixtures/hostile-page-text.js) and Forecast swapped for the poisoned one
// (lib/poisoned-forecast.js), which appends a live <img onerror> to every
// text field Forecast returns. The diagnostics section (#road-ahead) is shown
// and re-rendered so its renders run too, and every control is clicked once
// so sheets and detail views render. A MutationObserver records every element
// ever inserted. It proves, per world:
//   - no dialog opened (the payload calls alert);
//   - no inserted element is an img or carries an on* attribute;
//   - the poisoned text is visible, escaped, inside the areas the world names
//     (so the branch really ran).
// Served WITHOUT the production CSP on purpose: this proves the escaping
// itself, not the header behind it. Invented data only.
// CHROME_PATH=<Chromium> node test/browser-forecast-text-escaping.js
const fs = require('node:fs');
const path = require('node:path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {
  // In CI a skip would read as green, so a missing browser fails there.
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.error('browser-forecast-text-escaping: playwright is required in CI.');
    process.exit(1);
  }
  console.log('SKIP browser-forecast-text-escaping: playwright is not installed.');
  process.exit(0);
}
const H = require('./fixtures/hostile-page-text');
const P = require('./lib/poisoned-forecast');

const root = path.join(__dirname, '..');
const POLICY = { policy: 'true-surplus-highest-interest', provenance: 'owner-stated', summary: H.NOTE };
const worlds = {
  'debt policy': {
    data: () => { const d = H.hostile(); d.debts[0].structure = 'Revolving'; d.plan.nextDollar = POLICY; return d; },
    reach: ['[data-payday-breakdown="Extra on focus debt"]', '#phases'],
  },
  'plan unavailable': {
    data: () => { const d = H.hostile(); d.debts[0].structure = 'Revolving'; d.plan.nextDollar = POLICY;
      (d.plan.startingCash.breakdown || []).forEach(row => { row.value = null; }); return d; },
    reach: ['#status-band', '#transfer-note', '#nextmove-card', '[data-unavailable-primary]'],
  },
};

(async () => {
  const errors = [];
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
  try {
    for (const [name, world] of Object.entries(worlds)) {
      const data = world.data();
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
      await page.addInitScript(...P.browserInit);
      await page.addInitScript(() => {
        window.__injected = [];
        const note = el => {
          if (!el || el.nodeType !== 1) return;
          for (const node of [el, ...el.querySelectorAll('*')]) {
            const tag = node.tagName.toLowerCase();
            for (const a of node.attributes) if (/^on/i.test(a.name)) window.__injected.push(`${tag}[${a.name}]`);
            if (tag === 'img') window.__injected.push('img');
          }
        };
        new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(note)))
          .observe(document, { childList: true, subtree: true });
      });
      await page.goto('http://atlas.test/?view=classic');
      await page.waitForFunction(() => document.querySelector('[data-budget-surface]'), null, { timeout: 20000 })
        .catch(() => errors.push(`${name}: the Budget never rendered`));
      // Show the diagnostics section and render it.
      await page.evaluate(() => { const r = document.getElementById('road-ahead'); r.hidden = false; r.inert = false; App.rerender(); });
      await page.waitForTimeout(200);
      // Shown as text, before the clicks move the view: the poisoned Forecast
      // text, or the fixture's household note (plan-owned text such as
      // plan.nextDollar.summary).
      const missing = await page.evaluate(({ reach, markers }) => reach.filter(sel => ![...document.querySelectorAll(sel)]
        .some(el => markers.some(m => (el.textContent || '').includes(m)))),
      { reach: world.reach, markers: ['<img src=z data-poisoned-forecast', H.NOTE] });
      const n = await page.evaluate(() => {
        const controls = [...document.querySelectorAll('button, summary, [role="tab"], [data-budget-bill-open], [tabindex="0"]')];
        controls.forEach((el, i) => el.setAttribute('data-forecast-escape-probe', String(i)));
        return controls.length;
      });
      for (let i = 0; i < Math.min(n, 400); i++) {
        await page.click(`[data-forecast-escape-probe="${i}"]`, { timeout: 200, force: true }).catch(() => {});
      }
      await page.waitForTimeout(50);
      const face = { injected: await page.evaluate(() => window.__injected), missing };
      if (dialogs.length) errors.push(`${name}: dialog opened ${JSON.stringify(dialogs)}`);
      if (face.injected.length) errors.push(`${name}: injected ${[...new Set(face.injected)].join(', ')}`);
      if (face.missing.length) errors.push(`${name}: poisoned text not shown as text in ${face.missing.join(', ')}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  if (errors.length) {
    console.error('FAIL Forecast text escaping\n  ' + errors.join('\n  '));
    process.exit(1);
  }
  console.log('PASS poisoned Forecast text renders inert on the Budget page in Chromium');
})().catch(err => { console.error(err); process.exit(1); });
