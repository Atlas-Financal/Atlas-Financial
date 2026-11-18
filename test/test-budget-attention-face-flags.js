'use strict';
/* Every Budget attention item has a visible equivalent on the face
 * (lead ruling 2026-11-18). The face keeps the attention list off-stage
 * (paintFaceBadges adds blend-offstage) and its buttons are not Tab stops
 * (retireHiddenTabStops), so each item must show on the face itself:
 *   - a category item ("needs a category"): a visible badge on that
 *     category's ring carrying the state, or, for an over-plan ring, its
 *     visible Over plan pill;
 *   - a bill item ("to confirm"): its visible bill row reads To confirm.
 * Checked in both the Bars and the Rings view, at 1280 and 390 px.
 * The Other spending ring is the case that had no flag before.
 * Invented data only (test/fixtures/budget-surface-data).
 *
 * `node test/test-budget-attention-face-flags.js`
 * Skips when Playwright Chromium is not available.
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

let chromium;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
if (!chromium || process.env.ATLAS_SKIP_BROWSER === '1') {
  console.log('  SKIP  Playwright Chromium is not available here');
  process.exit(0);
}

const root = path.join(__dirname, '..');
const fx = require('./fixtures/budget-surface-data');

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', colorScheme: 'light' });
      page.on('pageerror', err => errors.push(err.message));
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.origin !== 'http://budget.test') return route.abort();
        if (u.pathname === '/data.json') return route.fulfill({ json: fx.served() });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) {
          return route.fulfill({ json: null });
        }
        const name = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
        const file = path.join(root, 'public', name);
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file),
          contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'text/html' });
      });
      await page.goto('http://budget.test/');
      await page.locator('[data-budget-surface]').waitFor();
      const tile = page.locator('[data-blend-cat="other-spending"]').first().locator('xpath=ancestor::section[1]');
      for (const mode of ['Bars', 'Rings']) {
        const toggle = tile.getByRole('button', { name: mode, exact: true });
        if (await toggle.count()) await toggle.first().click();
        console.log(`\n=== ${width}px, ${mode} ===`);
        const report = await page.evaluate(() => {
          const visible = el => {
            if (!el || el.closest('.blend-offstage, .blend-clip, [hidden]')) return false;
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
          };
          const items = [...document.querySelectorAll('[data-budget-browse="attention"] .budget-attention-item')];
          return {
            offstage: !!document.querySelector('[data-budget-browse="attention"].blend-offstage'),
            items: items.map(item => {
              const label = (item.querySelector('strong')?.textContent || '').trim();
              const state = label.slice(label.lastIndexOf(' · ') + 3);
              const cat = item.getAttribute('data-budget-category-open');
              const bill = item.getAttribute('data-budget-bill-open');
              if (cat) {
                const host = [...document.querySelectorAll('[data-blend-cat="' + CSS.escape(cat) + '"]')].find(visible);
                const badge = host && [...host.querySelectorAll('[data-blend-badge]')].find(b => visible(b) && b.textContent.trim() === state);
                const pill = host && [...host.querySelectorAll('.blend-over-pill')].find(visible);
                return { label, kind: 'category', host: !!host, flag: !!(badge || (/over plan$/.test(state) && pill)) };
              }
              const rows = [...document.querySelectorAll('[data-blend-bill^="' + CSS.escape(bill) + ':"]')].filter(visible);
              return { label, kind: 'bill', host: rows.length > 0, flag: rows.some(row => /to confirm/i.test(row.textContent)) };
            }),
          };
        });
        ok(report.offstage, 'the attention list is off-stage (the face is the only visible route)');
        ok(report.items.length >= 2, 'the invented fixture has attention items (Other spending and a bill)', String(report.items.length));
        ok(report.items.some(i => i.label === 'Other spending · needs a category'), 'Other spending needs a category is one of them');
        for (const item of report.items) {
          ok(item.host && item.flag, `${item.label}: visible on the face (${item.kind})`, JSON.stringify(item));
        }
      }
      await page.close();
    }
    ok(errors.length === 0, 'no browser runtime errors', errors.join(' | '));
  } finally {
    await browser.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nAll attention face-flag checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
