'use strict';
// M13: the Household tile face prints amounts in whole dollars, rounded up
// (owner-approved); the sheet keeps exact cents. Display tidy-up (owner
// screenshots): the face no longer carries the "Whole dollars, rounded up.
// Exact cents in the detail." footnote; the rounding itself is unchanged.
// CHROME_PATH=<Chromium> node test/browser-budget-rounding-note.js
// The fixture (other-period-target) is invented: an Other Spending spend of
// $137.26 must print $138 on the face with no rounding note.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/other-period-target');
const root = process.env.ATLAS_ROUNDING_NOTE_ROOT || path.join(__dirname, '..');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.origin !== 'http://budget.test') return route.abort();
        if (u.pathname === '/data.json') return route.fulfill({ json: fx.build(137.26).data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
        const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file),
          contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      });
      await page.goto('http://budget.test/');
      await page.locator('[data-blend-rings]').waitFor();
      const face = await page.evaluate(() => {
        const section = document.querySelector('[data-budget-browse="spending"]');
        const notes = section ? [...section.querySelectorAll('[data-blend-rounding-note]')] : [];
        const note = notes[0];
        const rect = note ? note.getBoundingClientRect() : null;
        const ring = section && section.querySelector('.blend-ring[data-blend-cat="other-spending"]');
        return {
          count: notes.length,
          text: note ? note.textContent : '',
          visible: !!(rect && rect.width > 0 && rect.height > 0 && getComputedStyle(note).visibility !== 'hidden'),
          sectionText: section ? section.textContent : '',
          ringText: ring ? ring.parentElement.innerText : '',
        };
      });
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      assert.equal(face.count, 0, `${width}px: no rounding note on the Household face`);
      assert.ok(!face.sectionText.includes('Exact cents in the detail'), `${width}px: the footnote sentence is absent from the Household tile`);
      assert.ok(!face.sectionText.includes('Whole dollars, rounded up'), `${width}px: the footnote sentence is absent from the Household tile`);
      assert.match(face.ringText, /\$138\b/, `${width}px: the invented $137.26 spend prints $138 with no note`);
      assert.doesNotMatch(face.ringText, /\$137\.26/, `${width}px: the face carries no cents`);
      await page.close();
    }
    console.log('browser-budget-rounding-note: ok');
  } finally {
    await browser.close();
  }
})().catch(err => { console.error(err); process.exit(1); });
